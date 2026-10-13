// Persistência simples em JSON na pasta de dados do usuário, com escrita atômica.
'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  version: 1,
  collections: [],
  history: [],
  environments: [{ id: 'env_local', name: 'Local', vars: [{ key: 'baseUrl', value: 'https://httpbin.org', enabled: true }] }],
  activeEnvId: 'env_local',
  theme: 'dark',
};

// crypto: { available(), encrypt(str)->base64, decrypt(base64)->str } — no app usa o safeStorage
// do Electron (DPAPI no Windows, Keychain no macOS), inspirado no keytar do Postman.
// Ambientes de todos os workspaces: o ativo fica no topo; os outros, guardados em workspaces[].data.
function allEnvs(d) {
  const list = [...(d.environments || [])];
  for (const w of d.workspaces || []) if (w && w.data) list.push(...(w.data.environments || []));
  return list;
}
function mapSecrets(data, fn) {
  const out = structuredClone(data);
  for (const env of allEnvs(out)) {
    for (const v of env.vars || []) if (v.secret) v.value = fn(v);
  }
  for (const [sec, key] of SETTING_SECRETS) {
    const o = out.settings && out.settings[sec];
    if (o && (o[key + 'Enc'] || o[key])) { o[key] = fn({ value: o[key], enc: o[key + 'Enc'] }); delete o[key + 'Enc']; }
  }
  for (const c of (out.settings && out.settings.certs) || []) {
    if (c.passphraseEnc || c.passphrase) { c.passphrase = fn({ value: c.passphrase, enc: c.passphraseEnc }); delete c.passphraseEnc; }
  }
  return out;
}
// Campos das configurações que vão criptografados para o disco.
const SETTING_SECRETS = [['proxy', 'password'], ['ai', 'apiKey'], ['ai', 'openaiKey'], ['postman', 'apiKey']];

function createStore(dir, crypto = null) {
  const file = path.join(dir, 'mono-data.json');
  const canCrypt = () => crypto && crypto.available();
  return {
    load() {
      try {
        const data = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
        return mapSecrets(data, (v) => {
          if (v.enc && canCrypt()) { try { return crypto.decrypt(v.enc); } catch { return ''; } }
          return v.value ?? '';
        });
      } catch {
        return structuredClone(DEFAULTS);
      }
    },
    save(data) {
      fs.mkdirSync(dir, { recursive: true });
      const toDisk = structuredClone(data);
      if (canCrypt()) {
        for (const env of allEnvs(toDisk)) {
          for (const v of env.vars || []) {
            if (v.secret) { v.enc = crypto.encrypt(String(v.value ?? '')); delete v.value; }
            else delete v.enc;
          }
        }
      }
      for (const [sec, key] of SETTING_SECRETS) {
        const o = toDisk.settings && toDisk.settings[sec];
        if (o && o[key] && canCrypt()) { o[key + 'Enc'] = crypto.encrypt(String(o[key])); delete o[key]; }
      }
      for (const c of (toDisk.settings && toDisk.settings.certs) || []) {
        if (c.passphrase && canCrypt()) { c.passphraseEnc = crypto.encrypt(String(c.passphrase)); delete c.passphrase; }
      }
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(toDisk, null, 2));
      fs.renameSync(tmp, file);
      return true;
    },
    file,
  };
}

module.exports = { createStore, DEFAULTS, allEnvs };
