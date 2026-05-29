import { describe, expect, it } from 'vitest';
import { rewritePublishManifest } from '../src/manifest-rewrite.js';

describe('rewritePublishManifest', () => {
  it('rewrites workspace and catalog dependency protocols', () => {
    const manifest = rewritePublishManifest({
      name: 'package-a',
      version: '1.0.0',
      dependencies: {
        'package-b': 'workspace:*',
        'package-c': 'workspace:^',
        'package-d': 'catalog:',
        'package-e': 'catalog:react18',
        'package-g': 'catalog:*',
        'package-f': '^1.2.3',
      },
    }, {
      catalogs: {
        default: {
          'package-d': '^4.0.0',
          'package-g': '^7.0.0',
        },
        named: {
          react18: {
            'package-e': '~5.0.0',
          },
        },
      },
      workspaceVersions: {
        'package-b': '2.0.0',
        'package-c': '3.0.0',
      },
    });

    expect(manifest.dependencies).toEqual({
      'package-b': '2.0.0',
      'package-c': '^3.0.0',
      'package-d': '^4.0.0',
      'package-e': '~5.0.0',
      'package-f': '^1.2.3',
      'package-g': '^7.0.0',
    });
  });

  it('uses live specs only for installable workspace dependencies', () => {
    const manifest = rewritePublishManifest({
      name: 'package-a',
      version: '1.0.0',
      dependencies: {
        'package-b': 'workspace:*',
      },
      devDependencies: {
        'package-dev': 'workspace:*',
      },
      optionalDependencies: {
        'package-optional': 'workspace:*',
      },
      peerDependencies: {
        'package-peer': 'workspace:^',
      },
    }, {
      catalogs: {
        default: {},
        named: {},
      },
      liveDependencyNames: ['package-b', 'package-dev', 'package-optional', 'package-peer'],
      workspaceVersions: {
        'package-b': '2.0.0',
        'package-dev': '3.0.0',
        'package-optional': '4.0.0',
        'package-peer': '5.0.0',
      },
    });

    expect(manifest).toMatchObject({
      dependencies: {
        'package-b': 'live:package-b',
      },
      devDependencies: {
        'package-dev': '3.0.0',
      },
      optionalDependencies: {
        'package-optional': 'live:package-optional',
      },
      peerDependencies: {
        'package-peer': '^5.0.0',
      },
    });
  });

  it('fails when a workspace protocol references a package without a version', () => {
    expect(() => rewritePublishManifest({
      name: 'package-a',
      version: '1.0.0',
      peerDependencies: {
        'package-peer': 'workspace:^',
      },
    }, {
      catalogs: {
        default: {},
        named: {},
      },
      workspaceVersions: {},
    })).toThrow('package-peer uses workspace:^');
  });
});
