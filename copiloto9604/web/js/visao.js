// Limelight: descobre em qual tabela da NetworkTables ela publica e quais
// AprilTags está vendo agora. Usado pela aba Limelight, Odometria e widgets.

import { cfg } from './config.js';
import { parseBotpose } from './campo.js';
import { nt } from './nt.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** true se a tabela recebe dados de uma Limelight. */
export function hasLimelight(table) {
  return nt.has(`/${table}/tv`) || nt.has(`/${table}/hb`);
}

/** Tabelas da NetworkTables que parecem Limelights (têm tv, tx e hb ou getpipe). */
export function detectLimelights() {
  const out = [];
  for (const name of nt.names()) {
    const m = /^\/([^/]+)\/tv$/.exec(name);
    if (!m) continue;
    const t = m[1];
    if (nt.has(`/${t}/tx`) && (nt.has(`/${t}/hb`) || nt.has(`/${t}/getpipe`))) out.push(t);
  }
  return out;
}

/**
 * Tabela a usar para uma Limelight configurada. Se o nome configurado não
 * existe na rede (ex.: escreveram o modelo, "limelight 4"), usa uma Limelight
 * encontrada que ainda não está configurada com outro nome — e avisa (fallback).
 */
export function resolveLimelight(configured) {
  const name = (configured || 'limelight').trim();
  if (hasLimelight(name)) return { table: name, configured: name, found: true, fallback: false, detected: [] };
  const detected = detectLimelights();
  const claimed = new Set((cfg.get('limelights', []) || []).map((l) => l.nome));
  const pick = detected.find((t) => !claimed.has(t)) || detected[0];
  if (pick) return { table: pick, configured: name, found: true, fallback: true, detected };
  return { table: name, configured: name, found: false, fallback: false, detected };
}

/** Tabela da primeira Limelight configurada (ou a encontrada na rede). */
export function mainLimelightTable() {
  return resolveLimelight((cfg.get('limelights', [])[0] || {}).nome).table;
}

/**
 * AprilTags vistas agora: [{ id, txnc, tync, ta, distCam, distRobot, ambiguity }].
 * Ordem das fontes: rawfiducials (firmware atual) → botpose MegaTag1 → MegaTag2
 * → só a tag principal (tid). Assim funciona mesmo sem o código do MegaTag2 no robô.
 */
export function visibleTags(table) {
  const raw = nt.get(`/${table}/rawfiducials`);
  if (Array.isArray(raw) && raw.length >= 7 && raw.length % 7 === 0) {
    const out = [];
    for (let i = 0; i + 6 < raw.length; i += 7) {
      out.push({ id: Math.round(raw[i]), txnc: raw[i + 1], tync: raw[i + 2], ta: raw[i + 3], distCam: raw[i + 4], distRobot: raw[i + 5], ambiguity: raw[i + 6] });
    }
    return out;
  }
  for (const key of ['botpose_wpiblue', 'botpose_orb_wpiblue', 'botpose']) {
    const bp = parseBotpose(nt.get(`/${table}/${key}`));
    if (bp && bp.fiducials.length) return bp.fiducials.map((f) => ({ ...f, id: Math.round(f.id) }));
  }
  const tv = nt.get(`/${table}/tv`), tid = nt.get(`/${table}/tid`);
  if ((tv === 1 || tv === true) && isNum(tid) && tid >= 0) {
    return [{ id: Math.round(tid), txnc: nt.get(`/${table}/tx`), tync: nt.get(`/${table}/ty`), ta: nt.get(`/${table}/ta`) }];
  }
  return [];
}

/** Pose do robô pela visão: MegaTag2 e MegaTag1 (null quando não há tags). */
export function visionPoses(table) {
  const mt2 = parseBotpose(nt.get(`/${table}/botpose_orb_wpiblue`));
  const mt1 = parseBotpose(nt.get(`/${table}/botpose_wpiblue`));
  return { mt2: mt2 && mt2.pose ? mt2 : null, mt1: mt1 && mt1.pose ? mt1 : null };
}
