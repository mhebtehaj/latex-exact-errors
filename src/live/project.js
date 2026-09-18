'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { parse } = require('./parser');
const { Metadata } = require('./metadata');
const { analyze } = require('./rules');
const allowed = (file, roots) => roots.some(root => { const r = path.relative(root, file); return r === '' || (!r.startsWith('..' + path.sep) && r !== '..' && !path.isAbsolute(r)); });
class Project {
  constructor(metadataPath) { this.metadata = new Metadata(metadataPath); this.cache = new Map(); }
  async run(request) {
    const { documents, candidates = [], roots = [] } = request;
    const realRoots = await Promise.all(roots.map(async root => { try { return await fs.realpath(root); } catch { return root; } }));
    const open = new Map(documents.map(d => [d.file, d]));
    const loaded = new Map();
    let bytes = 0;
    const read = async file => {
      if (loaded.has(file)) return loaded.get(file);
      if (loaded.size >= 512 || bytes > 16 * 1024 * 1024) return null;
      let text, signature;
      const doc = open.get(file);
      if (doc) { text = doc.text; signature = text; }
      else {
        if (!allowed(file, roots)) return null;
        try {
          // Resolve links before reading: package includes stay within the project.
          if (!allowed(await fs.realpath(file), realRoots)) return null;
          const stat = await fs.stat(file);
          if (stat.size > 2 * 1024 * 1024) return null;
          signature = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
          const cached = this.cache.get(file);
          text = cached?.signature === signature ? cached.parsed.text : await fs.readFile(file, 'utf8');
        } catch { return null; }
      }
      if (text.length > 2 * 1024 * 1024) return null;
      bytes += text.length;
      let entry = this.cache.get(file);
      if (!entry || entry.signature !== signature) { entry = { signature, parsed: parse(text) }; this.cache.set(file, entry); }
      loaded.set(file, entry.parsed); return entry.parsed;
    };
    // Bound the cache across deleted/renamed files and long editor sessions.
    if (this.cache.size > 1024) this.cache.clear();
    for (const file of [...new Set([...open.keys(), ...candidates])].slice(0, 512)) await read(file);
    const resolve = async (name, from, root, ext) => {
      if (!name || /[\\#$%{}\0]/.test(name)) return null;
      for (const dir of [...new Set([path.dirname(root), path.dirname(from)])]) {
        const file = path.resolve(dir, path.extname(name) ? name : name + ext);
        if (allowed(file, roots) && await read(file)) return file;
      }
      return null;
    };
    const expand = async (file, root, trail = []) => {
      if (trail.includes(file) || trail.length >= 40) return [{ kind: 'uncertain', file, start: 0, end: 1, reason: 'cyclic input' }];
      const parsed = await read(file);
      if (!parsed) return [];
      const events = [];
      for (const e of parsed.events) {
        const event = { ...e, file };
        if (e.kind === 'include') {
          const child = await resolve(e.value, file, root, '.tex');
          events.push({ ...event, child });
          if (child) events.push(...await expand(child, root, [...trail, file]));
        } else if (e.kind === 'package' || e.kind === 'class') {
          for (const name of e.value.split(',').map(n => n.trim())) {
            const local = await resolve(name, file, root, e.kind === 'class' ? '.cls' : '.sty');
            const info = await this.metadata.load(e.kind === 'class' ? 'class-' + name : name);
            events.push({ ...event, value: name, names: info.names, missing: local ? [] : info.missing });
            if (local) events.push(...await expand(local, root, [...trail, file]));
          }
        } else events.push(event);
      }
      return events;
    };
    const documentRoots = [...loaded].filter(([, p]) => p.events.some(e => e.kind === 'class')).map(([file]) => file);
    const expanded = new Map();
    for (const root of documentRoots) expanded.set(root, await expand(root, root));
    const base = await this.metadata.base();
    const results = [];
    const analyzed = new Map();
    for (const doc of documents) {
      if (doc.options?.enabled === false) continue;
      const magic = /^\s*%\s*!\s*TEX\s+root\s*=\s*(.+)$/im.exec(doc.text);
      let root;
      if (magic) root = await resolve(magic[1].trim(), doc.file, doc.file, '.tex');
      root ||= [...expanded].find(([, events]) => events.some(e => e.file === doc.file))?.[0] || doc.file;
      if (!expanded.has(root)) expanded.set(root, await expand(root, root));
      const key = root + JSON.stringify(doc.options || {});
      if (!analyzed.has(key)) analyzed.set(key, analyze(expanded.get(root), { base, sources: loaded, ...doc.options }));
      const result = analyzed.get(key);
      results.push({ file: doc.file, version: doc.version, findings: result.findings.filter(e => e.file === doc.file), uncertainty: result.uncertainty, root });
    }
    return { documents: results, cacheFiles: this.cache.size };
  }
}
module.exports = { Project };
