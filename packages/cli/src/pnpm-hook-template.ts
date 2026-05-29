export function createPnpmHooksCjs(): string {
  return `const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const prefix = 'live:';
const resolutionType = 'custom:live-npm';

function projectDirFromOptions(options) {
  return path.resolve(options.lockfileDir || options.projectDir || process.cwd());
}

function serverAddress(projectDir) {
  const overrideUrl = process.env.LIVE_NPM_URL;
  const overrideToken = process.env.LIVE_NPM_TOKEN;
  if (overrideUrl) {
    return readAddress(overrideUrl, overrideToken || '');
  }

  const serverFile = path.join(projectDir, '.live-npm', 'server.json');
  let serverState;
  try {
    serverState = JSON.parse(fs.readFileSync(serverFile, 'utf8'));
  } catch (error) {
    throw new Error(\`Could not read \${serverFile}. Start live-npm for this project before running pnpm install.\`);
  }
  if (!serverState || serverState.version !== 1 || typeof serverState.url !== 'string' || typeof serverState.token !== 'string') {
    throw new Error(\`\${serverFile} is not a valid live-npm server file.\`);
  }
  return readAddress(serverState.url, serverState.token);
}

function readAddress(urlText, token) {
  const url = new URL(urlText);
  const port = Number(url.port);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(\`live-npm server URL must include a port: \${urlText}\`);
  }
  return {
    host: url.hostname,
    pathPrefix: url.pathname === '/' ? '' : url.pathname.replace(/\\/$/, ''),
    port,
    protocol: url.protocol,
    token,
  };
}

function postJson(pathname, body, projectDir) {
  const address = serverAddress(projectDir);
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    if (address.protocol !== 'http:') {
      reject(new Error(\`Unsupported live-npm server protocol: \${address.protocol}\`));
      return;
    }
    const request = http.request({
      host: address.host,
      method: 'POST',
      path: \`\${address.pathPrefix}\${pathname}\`,
      port: address.port,
      headers: {
        'content-length': String(payload.byteLength),
        'content-type': 'application/json',
        'x-live-npm-token': address.token,
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if ((response.statusCode || 500) < 200 || (response.statusCode || 500) >= 300) {
          reject(new Error(readErrorMessage(text) || \`live-npm server returned \${response.statusCode}\`));
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

function readErrorMessage(text) {
  if (!text) {
    return '';
  }
  try {
    const body = JSON.parse(text);
    if (body && typeof body.error === 'string') {
      return body.error;
    }
  } catch (error) {
    return text;
  }
  return text;
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

    const projectDir = projectDirFromOptions(options);
    const result = await postJson('/resolve', {
      packageName,
      projectDir,
    }, projectDir);
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
    const projectDir = projectDirFromOptions(options);
    const result = await postJson('/fetch', {
      packageName: resolution.packageName,
      projectDir,
    }, projectDir);
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
    }, liveInfo.projectDir);
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

module.exports = function useLiveNPM(pnpmfile) {
  const base = pnpmfile && typeof pnpmfile === 'object' ? pnpmfile : {};
  const baseHooks = base.hooks && typeof base.hooks === 'object' ? base.hooks : {};
  const resolvers = Array.isArray(base.resolvers) ? base.resolvers : [];
  const fetchers = Array.isArray(base.fetchers) ? base.fetchers : [];

  return {
    ...base,
    hooks: {
      ...baseHooks,
      importPackage: livePnpm.importPackage,
    },
    resolvers: [
      ...resolvers,
      livePnpm.resolver,
    ],
    fetchers: [
      ...fetchers,
      livePnpm.fetcher,
    ],
  };
};
`;
}

export function createRootPnpmfileLiveBlock(): string {
  return `// <live-npm>
(() => {
  let useLiveNPM;
  try {
    useLiveNPM = require('./.live-npm/pnpmfile.cjs');
  } catch (error) {
    return;
  }
  module.exports = useLiveNPM(module.exports);
})();
// </live-npm>
`;
}
