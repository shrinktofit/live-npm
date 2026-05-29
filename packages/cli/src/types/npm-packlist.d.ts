declare module 'npm-packlist' {
  export default function packlist(tree: unknown): Promise<string[]>;
}

declare module '@npmcli/arborist' {
  export interface ArboristOptions {
    path: string;
  }

  export default class Arborist {
    constructor(options: ArboristOptions);
    loadActual(): Promise<unknown>;
  }
}
