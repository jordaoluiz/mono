// Assinatura digital XML (XMLDSig enveloped) com certificado A1 — padrão dos documentos fiscais
// (NF-e, NFC-e, CT-e, MDF-e, eventos, inutilização): C14N 1.0, RSA-SHA1 e Reference URI="#Id".
// SHA-256 também disponível (eSocial, Reinf, algumas NFS-e).
'use strict';
const crypto = require('crypto');
const X = require('./shared/xml');
const pkcs12 = require('./pkcs12');

const DSIG = 'http://www.w3.org/2000/09/xmldsig#';
const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';
const ALGS = {
  sha1: { hash: 'sha1', sig: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1', dig: 'http://www.w3.org/2000/09/xmldsig#sha1' },
  sha256: { hash: 'sha256', sig: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', dig: 'http://www.w3.org/2001/04/xmlenc#sha256' },
};
const SOAP_NS = ['http://schemas.xmlsoap.org/soap/envelope/', 'http://www.w3.org/2003/05/soap-envelope'];

// O documento fiscal termina onde começa o envelope: namespaces do SOAP (e do wrapper nfeDadosMsg)
// não entram na canonicalização — a SEFAZ valida o XML fiscal separado do envelope.
function boundaryFor(el) {
  for (let e = el; e.parent; e = e.parent) {
    const p = e.parent;
    const uri = X.nsUri(p);
    if (SOAP_NS.includes(uri) || /\/wsdl\//i.test(uri) || /DadosMsg$|CabecMsg$/i.test(p.local)) return p;
  }
  return null;
}
const idOf = (el) => X.attr(el, 'Id') ?? X.attr(el, 'ID') ?? X.attr(el, 'id');
// Elementos com Id que costumam ser assinados — para sugerir na interface.
function candidates(xml) {
  const doc = X.parse(xml);
  const seen = new Map();
  for (const e of X.walk(doc.root)) if (idOf(e) && e.local !== 'Signature') seen.set(e.local, (seen.get(e.local) || 0) + 1);
  return [...seen].map(([tag, count]) => ({ tag, count }));
}

function signedInfoXml(uri, digest, a) {
  return `<SignedInfo xmlns="${DSIG}"><CanonicalizationMethod Algorithm="${C14N}"/><SignatureMethod Algorithm="${a.sig}"/>` +
    `<Reference URI="${uri}"><Transforms><Transform Algorithm="${ENVELOPED}"/><Transform Algorithm="${C14N}"/></Transforms>` +
    `<DigestMethod Algorithm="${a.dig}"/><DigestValue>${digest}</DigestValue></Reference></SignedInfo>`;
}

// opts: { tag ('' = documento inteiro), pfx, passphrase, alg: 'sha1'|'sha256', minify: true }
function sign(xml, { tag = '', pfx, passphrase = '', alg = 'sha1', minify = true, key, cert } = {}) {
  const a = ALGS[alg] || ALGS.sha1;
  if (!key) ({ key, cert } = pkcs12.load(pfx, passphrase));
  const certB64 = Buffer.from(cert).toString('base64');
  const doc = X.parse(xml);
  if (minify) X.minify(doc);
  const targets = tag ? X.findAll(doc.root, tag).filter((e) => !(e.local === 'Signature')) : [doc.root];
  if (!targets.length) throw new Error(`Não encontrei <${tag}> no XML.`);
  for (const target of targets) {
    const id = idOf(target);
    if (tag && id == null) throw new Error(`<${tag}> não tem o atributo Id, que a assinatura referencia.`);
    const uri = tag ? `#${id}` : '';
    const atRoot = !tag;
    const holder = atRoot ? target : target.parent;
    if (!holder) throw new Error('O elemento assinado precisa estar dentro de outro (ex.: <NFe><infNFe/></NFe>).');
    // Reassinar: tira a assinatura anterior.
    holder.children = holder.children.filter((c) => !(c.type === 'el' && c.local === 'Signature' && X.nsUri(c) === DSIG && (atRoot || holder.children.indexOf(c) === holder.children.indexOf(target) + 1)));
    const boundary = boundaryFor(target);
    const digest = crypto.createHash(a.hash).update(X.c14n(target, { boundary }), 'utf8').digest('base64');
    const sigEl = X.fragment(`<Signature xmlns="${DSIG}">${signedInfoXml(uri, digest, a)}<SignatureValue></SignatureValue><KeyInfo><X509Data><X509Certificate>${certB64}</X509Certificate></X509Data></KeyInfo></Signature>`, holder);
    if (atRoot) holder.children.push(sigEl);
    else holder.children.splice(holder.children.indexOf(target) + 1, 0, sigEl);
    const si = X.children(sigEl, 'SignedInfo')[0];
    si.attrs = si.attrs.filter((x) => x.name !== 'xmlns'); // já declarado na <Signature>
    const value = crypto.sign(a.hash, Buffer.from(X.c14n(si, { boundary }), 'utf8'), key).toString('base64');
    X.children(sigEl, 'SignatureValue')[0].children = [{ type: 'text', value }];
  }
  return X.serialize(doc);
}

// Confere as assinaturas do XML (digest + valor da assinatura com o certificado do KeyInfo).
function verify(xml) {
  const doc = X.parse(xml);
  const sigs = X.findAll(doc.root, 'Signature').filter((s) => X.nsUri(s) === DSIG);
  if (!sigs.length) return { ok: false, results: [], error: 'Nenhuma assinatura encontrada.' };
  const results = sigs.map((sig) => {
    try {
      const si = X.children(sig, 'SignedInfo')[0];
      const ref = X.children(si, 'Reference')[0];
      const uri = X.attr(ref, 'URI') || '';
      const digAlg = X.attr(X.children(ref, 'DigestMethod')[0], 'Algorithm');
      const sigAlg = X.attr(X.children(si, 'SignatureMethod')[0], 'Algorithm');
      const a = Object.values(ALGS).find((x) => x.sig === sigAlg) || ALGS.sha1;
      const dHash = Object.values(ALGS).find((x) => x.dig === digAlg)?.hash || 'sha1';
      let target;
      if (uri.startsWith('#')) target = [...X.walk(doc.root)].find((e) => idOf(e) === uri.slice(1));
      else target = sig.parent;
      if (!target) throw new Error(`Referência ${uri} não encontrada.`);
      // transformação enveloped: tira a própria assinatura antes do digest
      const saved = target.children;
      if (sig.parent === target || target === doc.root) target.children = target.children.filter((c) => c !== sig);
      const boundary = boundaryFor(target);
      const digest = crypto.createHash(dHash).update(X.c14n(target, { boundary }), 'utf8').digest('base64');
      target.children = saved;
      const digestOk = digest === X.text(X.children(ref, 'DigestValue')[0]).trim();
      const certB64 = X.text(X.find(sig, 'X509Certificate')).replace(/\s+/g, '');
      const x509 = new crypto.X509Certificate(Buffer.from(certB64, 'base64'));
      const sigOk = crypto.verify(a.hash, Buffer.from(X.c14n(si, { boundary: boundaryFor(si) }), 'utf8'), x509.publicKey, Buffer.from(X.text(X.children(sig, 'SignatureValue')[0]).replace(/\s+/g, ''), 'base64'));
      return { uri, ok: digestOk && sigOk, digestOk, signatureOk: sigOk, subject: x509.subject.replace(/\n/g, ', '), validTo: x509.validTo };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  return { ok: results.every((r) => r.ok), results };
}

module.exports = { sign, verify, candidates, boundaryFor };
