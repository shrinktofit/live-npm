export interface PnpmHookTemplateOptions {
  defaultHost: string;
  defaultPort: number;
}

export function createPnpmHooksCjs(options: PnpmHookTemplateOptions): string {
  return `const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const prefix = 'live:';
const resolutionType = 'custom:live-npm';
const defaultHost = ${JSON.stringify(options.defaultHost)};
const defaultPort = ${JSON.stringify(options.defaultPort)};

function projectDirFromOptions(options) {
  return path.resolve(options.lockfileDir || options.projectDir || process.cwd());
}

function serverAddress() {
  return {
    host: process.env.LIVE_NPM_HOST || defaultHost,
    port: Number(process.env.LIVE_NPM_PORT || defaultPort),
  };
}

function postJson(pathname, body) {
  const address = serverAddress();
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: address.host,
      method: 'POST',
      path: pathname,
      port: address.port,
      headers: {
        'content-length': String(payload.byteLength),
        'content-type': 'application/json',
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if ((response.statusCode || 500) < 200 || (response.statusCode || 500) >= 300) {
          reject(new Error(text || \`live-npm server returned \${response.statusCode}\`));
          return;
        }
        try {
          resolve(text ? JSON.parse(text) : {});
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('error', (error) => {
      reject(new Error(\`Could not reach live-npm server at http://\${address.host}:\${address.port}: \${error.message}\`));
    });
    request.end(payload);
  });
}

function readLivePackageName(wantedDependency) {
  const bareSpecifier = wantedDependency && wantedDependency.bareSpecifier;
  if (typeof bareSpecifier !== 'string' || !bareSpecifier.startsWith(prefix)) {
    return undefined;
  }
  return bareSpecifier.slice(prefix.length);
}

function normalizeVersion(manifest) {
  if (manifest && typeof manifest.version === 'string' && manifest.version.length > 0) {
    return manifest.version;
  }
  return '0.0.0';
}

const resolver = {
  canResolve(wantedDependency) {
    return Boolean(readLivePackageName(wantedDependency));
  },

  async resolve(wantedDependency, options) {
    const packageName = readLivePackageName(wantedDependency);
    if (!packageName) {
      throw new Error('live-npm resolver received a non-live dependency.');
    }

    const result = await postJson('/resolve', {
      packageName,
      projectDir: projectDirFromOptions(options),
    });
    const version = normalizeVersion(result.manifest);

    return {
      id: \`live:\${result.packageName}@\${version}\`,
      latest: version,
      manifest: result.manifest,
      normalizedBareSpecifier: \`live:\${result.packageName}\`,
      resolution: {
        packageName: result.packageName,
        type: resolutionType,
      },
      resolvedVia: 'live-npm',
    };
  },

  shouldRefreshResolution(_wantedDependency, resolution) {
    return resolution && resolution.type === resolutionType;
  },
};

const fetcher = {
  async canFetch(_packageId, resolution) {
    return Boolean(resolution && resolution.type === resolutionType);
  },

  async fetch(_cafs, resolution, options) {
    const result = await postJson('/fetch', {
      packageName: resolution.packageName,
      projectDir: projectDirFromOptions(options),
    });
    const filesMap = await listFilesMap(result.stagingDir);
    return {
      filesMap,
      local: true,
      manifest: result.manifest,
      packageImportMethod: 'copy',
      requiresBuild: packageRequiresBuild(result.manifest),
    };
  },
};

async function importPackage(destinationDir, options) {
  await importFiles(options.filesMap, destinationDir, options);
  const liveInfo = findLivePackageInfo(options.filesMap);
  if (liveInfo) {
    await postJson('/register-import', {
      destinationDir,
      packageName: liveInfo.packageName,
      projectDir: liveInfo.projectDir,
    });
  }
  return 'copy';
}

async function listFilesMap(root) {
  const filesMap = new Map();
  await collectFiles(root, root, filesMap);
  return filesMap;
}

async function collectFiles(root, dir, filesMap) {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    if (entry.name === 'node_modules') {
      return;
    }
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(root, fullPath).replace(/\\\\/g, '/');
    if (entry.isDirectory()) {
      await collectFiles(root, fullPath, filesMap);
      return;
    }
    if (entry.isFile()) {
      filesMap.set(relativePath, fullPath);
    }
  }));
}

async function importFiles(filesMap, destinationDir, options) {
  const stage = \`\${destinationDir}.live-npm-\${process.pid}-\${Date.now()}\`;
  await fs.promises.rm(stage, { force: true, recursive: true });
  await fs.promises.mkdir(stage, { recursive: true });

  for (const [relativePath, sourcePath] of filesMap) {
    const targetPath = path.join(stage, ...relativePath.split('/'));
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.promises.copyFile(sourcePath, targetPath);
    const stats = await fs.promises.stat(sourcePath);
    await fs.promises.chmod(targetPath, stats.mode);
  }

  if (options.keepModulesDir) {
    await moveIfExists(path.join(destinationDir, 'node_modules'), path.join(stage, 'node_modules'));
  }

  await fs.promises.mkdir(path.dirname(destinationDir), { recursive: true });
  await fs.promises.rm(destinationDir, { force: true, recursive: true });
  await moveOrCopy(stage, destinationDir);
}

async function moveIfExists(source, target) {
  try {
    await fs.promises.stat(source);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await moveOrCopy(source, target);
}

async function moveOrCopy(source, target) {
  try {
    await fs.promises.rename(source, target);
  } catch (error) {
    if (!error || (error.code !== 'EXDEV' && error.code !== 'EPERM' && error.code !== 'EACCES')) {
      throw error;
    }
    await fs.promises.cp(source, target, { force: true, recursive: true });
    await fs.promises.rm(source, { force: true, recursive: true });
  }
}

function findLivePackageInfo(filesMap) {
  const marker = \`\${path.sep}.live-npm\${path.sep}store\${path.sep}\`;
  const lowerMarker = marker.toLowerCase();
  for (const sourcePath of filesMap.values()) {
    const normalized = path.normalize(sourcePath);
    const index = normalized.toLowerCase().indexOf(lowerMarker);
    if (index < 0) {
      continue;
    }
    const rest = normalized.slice(index + marker.length);
    const encodedName = rest.split(path.sep)[0];
    if (!encodedName) {
      continue;
    }
    return {
      packageName: decodeURIComponent(encodedName),
      projectDir: normalized.slice(0, index),
    };
  }
  return undefined;
}

function packageRequiresBuild(manifest) {
  const scripts = manifest && manifest.scripts;
  return Boolean(scripts && (scripts.preinstall || scripts.install || scripts.postinstall));
}

module.exports = {
  fetcher,
  importPackage,
  resolver,
};
`;
}

export function createPnpmfileCjs(): string {
  return `const livePnpm = require('./pnpm-hooks.cjs');

module.exports = {
  hooks: {
    importPackage: livePnpm.importPackage,
  },
  resolvers: [
    livePnpm.resolver,
  ],
  fetchers: [
    livePnpm.fetcher,
  ],
};
`;
}

export function createRootPnpmfileShim(): string {
  return `module.exports = require('./.live-npm/pnpmfile.cjs');
`;
}

export function createPnpmfileMergeSnippet(): string {
  return `const livePnpm = require('./.live-npm/pnpm-hooks.cjs');

module.exports = {
  hooks: {
    // Keep your existing hooks here.
    importPackage: livePnpm.importPackage,
  },
  resolvers: [
    // Keep your existing resolvers here.
    livePnpm.resolver,
  ],
  fetchers: [
    // Keep your existing fetchers here.
    livePnpm.fetcher,
  ],
};
`;
}
