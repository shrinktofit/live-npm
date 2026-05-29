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
});
