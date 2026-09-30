import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export class StateStore {
  constructor(path) {
    this.path = path;
    this.data = { scopes: {}, messages: {} };
    this.writes = Promise.resolve();
  }

  async load() {
    try {
      this.data = JSON.parse(await readFile(this.path, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    this.data.scopes ??= {};
    this.data.messages ??= {};
    return this;
  }

  scope(id) {
    return this.data.scopes[id];
  }

  message(id) {
    return this.data.messages[id];
  }

  async update(mutator) {
    mutator(this.data);
    const contents = JSON.stringify(this.data, null, 2);
    this.writes = this.writes.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.tmp`;
      await writeFile(temporary, contents, { mode: 0o600 });
      await rename(temporary, this.path);
    });
    return this.writes;
  }
}
