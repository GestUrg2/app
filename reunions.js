/* =====================================================================
   reunions.js — Moteur de réunions GestUrg2 (partagé Calendrier / Affectations)
   - Droit requis : pages.creerRDV === true (création, modification, suppression)
   - Disponibilités en direct (congé / affectation / autre réunion)
   - Assistant "meilleur créneau", frise de disponibilités, conflits de salle
   - Répétition (hebdo / plusieurs jours), rappel, lien visio, RSVP, export .ics
   ===================================================================== */
import { doc, addDoc, setDoc, updateDoc, deleteDoc, collection, serverTimestamp, increment }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const iso = d => { const z = new Date(d - d.getTimezoneOffset() * 6e4); return z.toISOString().slice(0, 10) };
const tm = t => { const [a, b] = String(t || '').split(':'); return a === undefined || b === undefined || a === '' ? NaN : +a * 60 + +b };
const hm = m => String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const JS = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
const ICS_DAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
export const CATS = { reunion: 'Réunion', staff: 'Staff / relève', formation: 'Formation', autre: 'Événement' };
export const MODES = { presentiel: 'Sur place', distanciel: 'En distanciel', hybride: 'Hybride' };

export const applique = (a, d) => {
  if (a.date && a.dateFin) return a.date <= d && d <= a.dateFin;
  if (a.date) return a.date === d;
  return (a.jours || []).includes(new Date(d + 'T00:00').getDay()) && (!a.depuis || d >= a.depuis) && (!a.jusqu || d <= a.jusqu);
};
export const premiereDate = ev => {
  if (ev.date) return ev.date;
  const d = new Date((ev.depuis || iso(new Date())) + 'T12:00');
  for (let i = 0; i < 14; i++, d.setDate(d.getDate() + 1)) if (applique(ev, iso(d))) return iso(d);
  return ev.depuis || iso(new Date());
};
export const quand = ev => {
  if (ev.jours) return 'Chaque ' + [...ev.jours].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map(j => JS[j].toLowerCase()).join(', ') + (ev.depuis ? ' dès le ' + fr(ev.depuis) : '') + (ev.jusqu ? ' jusqu’au ' + fr(ev.jusqu) : '');
  return ev.dateFin && ev.dateFin !== ev.date ? `Du ${fr(ev.date)} au ${fr(ev.dateFin)}` : fr(ev.date);
};
const fr = k => k ? new Date(k + 'T12:00').toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : '—';
export const resumeRSVP = ev => {
  const r = ev.responses || {}, ids = ev.participants || [], c = { oui: 0, non: 0, pe: 0, att: 0 };
  ids.forEach(u => { const v = r[u]; v === 'oui' ? c.oui++ : v === 'non' ? c.non++ : v === 'peut-etre' ? c.pe++ : c.att++ });
  return c;
};

/* ---------- Notifications via la messagerie interne ----------
   Message déposé dans messageries/notif-cal-<uid> (même format que les comptes
   d'envoi de messagerie.html : type « compte-administratif », lecture seule pour
   le destinataire) + notification push via le shell (comme fiche.html).
   Le compte « Notification calendrier » n'a aucun membre : personne ne peut
   écrire depuis lui, il ne sert qu'aux envois automatiques ci-dessous. */
export const COMPTE_NOTIF_CALENDRIER = { id: 'notification-calendrier', nom: 'Notification calendrier', icon: '📅' };
async function envoyerNotif(o, uid, titre, contenu, ref, nomDest) {
  const C = COMPTE_NOTIF_CALENDRIER;
  try {
    const cref = doc(o.db, 'messageries', 'notif-cal-' + uid), maj = { lastMessage: titre, updatedAt: serverTimestamp() };
    try { await updateDoc(cref, { ...maj, ['nonLus.' + uid]: increment(1) }) }
    catch (e) {
      if (e?.code !== 'not-found') throw e;
      await setDoc(cref, { type: 'compte-administratif', participants: [uid], destinataireUid: uid, compteId: C.id, compteNom: C.nom,
        titre: C.nom + ' · ' + (nomDest || uid), icon: C.icon, createdAt: serverTimestamp(), ...maj, nonLus: { [uid]: 1 } });
    }
    await addDoc(collection(cref, 'messages'), { auteur: C.id, auteurNom: C.nom, type: 'message', texte: titre + '\n\n' + contenu,
      evenementId: ref?.id || null, date: serverTimestamp(), luPar: [] });
  } catch (e) { console.warn('Notification calendrier (messagerie) :', e) }
  try {
    if (window.parent && window.parent !== window) window.parent.postMessage({ type: 'NOTIFICATION', userId: uid, titre, contenu }, '*');
  } catch (e) { console.warn('Notification calendrier (push) :', e) }
}

/* ---------- Export .ics ---------- */
export function ics(ev) {
  const dt = (k, t) => k.replace(/-/g, '') + 'T' + t.replace(':', '') + '00';
  const t = s => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const k0 = premiereDate(ev), L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//GestUrg2//Reunions//FR', 'BEGIN:VEVENT',
    `UID:${ev.id || Date.now()}@gesturg2`, 'DTSTAMP:' + new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z',
    'DTSTART:' + dt(k0, ev.start), 'DTEND:' + dt(k0, ev.end), 'SUMMARY:' + t(ev.titre)];
  if (ev.jours) L.push('RRULE:FREQ=WEEKLY;BYDAY=' + ev.jours.map(j => ICS_DAY[j]).join(',') + (ev.jusqu ? ';UNTIL=' + ev.jusqu.replace(/-/g, '') + 'T235959' : ''));
  else if (ev.dateFin && ev.dateFin !== ev.date) L.push('RRULE:FREQ=DAILY;UNTIL=' + ev.dateFin.replace(/-/g, '') + 'T235959');
  const lieu = ev.mode === 'distanciel' ? ev.lien : [ev.lieu, ev.mode === 'hybride' ? ev.lien : ''].filter(Boolean).join(' · ');
  if (lieu) L.push('LOCATION:' + t(lieu));
  const desc = [ev.description, ev.lien && 'Visio : ' + ev.lien].filter(Boolean).join('\n');
  if (desc) L.push('DESCRIPTION:' + t(desc));
  if (+ev.rappel > 0) L.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + t(ev.titre), 'TRIGGER:-PT' + ev.rappel + 'M', 'END:VALARM');
  L.push('END:VEVENT', 'END:VCALENDAR');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([L.join('\r\n')], { type: 'text/calendar;charset=utf-8' }));
  a.download = (norm(ev.titre).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'reunion') + '.ics';
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove() }, 500);
}

/* ---------- Styles + HTML du dialogue (injectés une seule fois) ---------- */
const CSS = `
.rv{width:min(940px,calc(100% - 24px));max-height:calc(100% - 24px);padding:0;border:1px solid var(--line,#d8e1ea);border-radius:16px;box-shadow:0 8px 32px rgba(17,35,54,.2);color:var(--ink,#112336);font-family:var(--font,system-ui,sans-serif)}
.rv::backdrop{background:rgba(17,35,54,.4)}
.rv *{box-sizing:border-box}
.rv-h{display:flex;justify-content:space-between;align-items:center;padding:14px 20px;border-bottom:1px solid var(--line,#d8e1ea)}
.rv-h h2{margin:0;font-size:17px}
.rv-x{width:34px;height:34px;font-size:21px;background:#fff;border:1px solid var(--line,#d8e1ea);border-radius:10px;cursor:pointer}
.rv-b{display:grid;grid-template-columns:1fr 1fr;gap:0;overflow:hidden;max-height:calc(100vh - 170px)}
.rv-col{display:grid;gap:12px;align-content:start;padding:16px 20px;overflow-y:auto;max-height:calc(100vh - 170px)}
.rv-col+.rv-col{border-left:1px solid var(--line-soft,#e9eff5);background:#fbfdff}
@media(max-width:780px){.rv-b{grid-template-columns:1fr;overflow-y:auto}.rv-col{max-height:none;overflow:visible}.rv-col+.rv-col{border-left:0;border-top:1px solid var(--line-soft,#e9eff5)}}
.rv label,.rv .rv-l{display:block;margin:0 0 5px;font-size:12.5px;font-weight:600;color:var(--muted,#586a7e)}
.rv input,.rv select,.rv textarea{width:100%;min-height:38px;padding:0 10px;font:500 14px var(--font,system-ui);color:var(--ink,#112336);background:#fff;border:1px solid var(--line,#d8e1ea);border-radius:10px}
.rv textarea{min-height:64px;padding:8px 10px;resize:vertical}
.rv input[type=checkbox]{width:auto;min-height:0}
.rv input:focus,.rv select:focus,.rv textarea:focus{outline:0;border-color:var(--primary,#0b6fa4);box-shadow:0 0 0 4px rgba(11,111,164,.15)}
.rv-g2{display:grid;grid-template-columns:1fr 1fr;gap:10px}.rv-g3{display:grid;grid-template-columns:1.4fr 1fr 1fr;gap:10px}
.rv-chips{display:flex;flex-wrap:wrap;gap:6px}
.rv-chip{min-height:30px;padding:0 11px;font:600 12.5px var(--font,system-ui);color:var(--ink,#112336);background:#fff;border:1px solid var(--line,#d8e1ea);border-radius:999px;cursor:pointer}
.rv-chip:hover{background:var(--primary-soft,#e3f1f9)}.rv-chip.on{background:var(--primary,#0b6fa4);border-color:var(--primary,#0b6fa4);color:#fff}
.rv-btn{min-height:36px;padding:0 13px;font:600 13.5px var(--font,system-ui);border-radius:10px;cursor:pointer;border:1px solid var(--line,#d8e1ea);background:#fff;color:var(--primary,#0b6fa4)}
.rv-btn:hover{background:var(--primary-soft,#e3f1f9)}
.rv-btn.pri{background:var(--primary,#0b6fa4);border-color:var(--primary,#0b6fa4);color:#fff}.rv-btn.pri:hover{filter:brightness(.94)}.rv-btn.pri:disabled{opacity:.5;cursor:wait}
.rv-btn.dng{color:var(--late,#b92a30);border-color:#f0c3c5}.rv-btn.dng:hover{background:var(--late-soft,#fdecec)}
.rv-btn.ai{background:linear-gradient(135deg,#6b3fc4,#0b6fa4);border:0;color:#fff;width:100%}.rv-btn.ai:hover{filter:brightness(1.07);background:linear-gradient(135deg,#6b3fc4,#0b6fa4)}
.rv-f{display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;padding:12px 20px;border-top:1px solid var(--line,#d8e1ea)}.rv-f .dng{margin-right:auto}
.rv-hint{margin:0;font-size:12.5px;color:var(--muted,#586a7e)}
.rv-warn{padding:8px 11px;border-radius:10px;font-size:12.5px;font-weight:600;color:#a35a00;background:#ffefc7}
.rv-sug{display:grid;gap:6px}
.rv-sg{display:flex;justify-content:space-between;align-items:center;gap:10px;width:100%;padding:8px 12px;text-align:left;font:inherit;background:#fff;border:1px solid var(--line,#d8e1ea);border-radius:10px;cursor:pointer}
.rv-sg:hover{border-color:var(--primary,#0b6fa4);background:var(--primary-soft,#e3f1f9)}
.rv-sg b{font-size:13.5px;text-transform:capitalize}.rv-sg small{display:block;font-size:12px;color:var(--muted,#586a7e)}
.rv-ok{font-size:11.5px;font-weight:700;padding:3px 8px;border-radius:999px;white-space:nowrap;color:var(--ok,#16784a);background:var(--ok-soft,#e1f4e9)}
.rv-ok.mid{color:#a35a00;background:#ffefc7}.rv-ok.bad{color:var(--late,#b92a30);background:var(--late-soft,#fdecec)}
.rv-tools{display:grid;grid-template-columns:1fr auto;gap:8px}
.rv-pf{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.rv-list{display:grid;gap:5px;max-height:230px;overflow-y:auto;padding:2px}
.rv-it{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 10px;background:#fff;border:1px solid var(--line,#d8e1ea);border-radius:10px}
.rv-it.sel{border-color:var(--primary,#0b6fa4);background:var(--primary-soft,#e3f1f9)}
.rv-in{min-width:0;flex:1}.rv-in b{display:block;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rv-in small{display:block;font-size:11.5px;color:var(--muted,#586a7e);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rv-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px;background:#16784a}.rv-dot.soft{background:#e08a00}.rv-dot.hard{background:#b92a30}
.rv-rl{display:flex;gap:4px;flex:none}
.rv-rb{padding:3px 9px;font:600 11.5px var(--font,system-ui);border-radius:6px;border:1px solid var(--line,#d8e1ea);background:#fff;cursor:pointer}
.rv-rb.m{background:var(--primary,#0b6fa4);border-color:var(--primary,#0b6fa4);color:#fff}.rv-rb.o{background:var(--primary-soft,#e3f1f9);border-color:var(--primary,#0b6fa4);color:var(--primary-d,#085a86)}
.rv-tl{display:grid;gap:3px;padding:8px;background:#fff;border:1px solid var(--line,#d8e1ea);border-radius:12px}
.rv-tr{display:grid;grid-template-columns:96px 1fr;gap:8px;align-items:center}
.rv-tn{font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.rv-tn i{font-weight:500;color:var(--muted,#586a7e)}
.rv-trk{position:relative;height:18px;background:repeating-linear-gradient(90deg,#f1f5f9 0 1px,transparent 1px calc(100%/13));border-radius:5px;background-color:#f8fafc}
.rv-bl{position:absolute;top:2px;bottom:2px;border-radius:4px;background:rgba(224,138,0,.35)}.rv-bl.hard{background:rgba(185,42,48,.55)}
.rv-win{position:absolute;top:-2px;bottom:-2px;border:2px solid var(--primary,#0b6fa4);background:rgba(11,111,164,.12);border-radius:5px;pointer-events:none}
.rv-ax{position:relative;height:14px;font-size:10.5px;color:var(--muted,#586a7e)}.rv-ax span{position:absolute;transform:translateX(-50%)}
.rv-leg{display:flex;gap:10px;flex-wrap:wrap;font-size:11.5px;color:var(--muted,#586a7e)}
.rv details{border:1px dashed var(--line,#d8e1ea);border-radius:10px;padding:8px 12px}.rv summary{cursor:pointer;font-size:13px;font-weight:600;color:var(--muted,#586a7e)}
.rv-opt{display:flex;align-items:center;gap:8px;margin:8px 0 0!important;font-size:13px!important;color:var(--ink,#112336)!important;font-weight:500!important}
`;

const HTML = `
<div class="rv-h"><h2 id="rvT">Nouvelle réunion</h2><button type="button" class="rv-x" id="rvX" aria-label="Fermer">×</button></div>
<div class="rv-b">
 <div class="rv-col">
  <div class="rv-g2"><div><label for="rvTitre">Titre</label><input id="rvTitre" placeholder="Ex. Staff des urgences"></div>
   <div><label for="rvCat">Type</label><select id="rvCat"><option value="reunion">Réunion</option><option value="staff">Staff / relève</option><option value="formation">Formation</option><option value="autre">Autre événement</option></select></div></div>
  <div class="rv-g3"><div><label for="rvD1">Date</label><input id="rvD1" type="date"></div><div><label for="rvS">Début</label><input id="rvS" type="time"></div><div><label for="rvE">Fin</label><input id="rvE" type="time"></div></div>
  <div><span class="rv-l">Durée</span><div class="rv-chips" id="rvDur"></div></div>
  <div class="rv-g2"><div><label for="rvRep">Répétition</label><select id="rvRep"><option value="once">Une seule fois</option><option value="range">Plusieurs jours consécutifs</option><option value="weekly">Chaque semaine</option></select></div>
   <div id="rvD2Box" hidden><label for="rvD2" id="rvD2L">Au (inclus)</label><input id="rvD2" type="date"></div></div>
  <div id="rvDaysBox" hidden><span class="rv-l">Jours de la semaine</span><div class="rv-chips" id="rvDays"></div></div>
  <div class="rv-g2"><div><label for="rvMode">Modalité</label><select id="rvMode"><option value="presentiel">Sur place</option><option value="distanciel">Distanciel (visio)</option><option value="hybride">Hybride</option></select></div>
   <div><label for="rvRap">Rappel</label><select id="rvRap"><option value="0">Aucun</option><option value="10">10 min avant</option><option value="15" selected>15 min avant</option><option value="30">30 min avant</option><option value="60">1 h avant</option><option value="1440">1 jour avant</option></select></div></div>
  <div id="rvLieuBox"><label for="rvLieu">Lieu / salle</label><input id="rvLieu" list="rvRooms" placeholder="Salle Bâtiment C"><datalist id="rvRooms"></datalist><div id="rvSalle" class="rv-warn" hidden style="margin-top:6px"></div></div>
  <div id="rvLienBox" hidden><label for="rvLien">Lien visio</label><div class="rv-tools"><input id="rvLien" type="url" placeholder="https://…"><button type="button" class="rv-btn" id="rvGen">Générer</button></div></div>
  <div><label for="rvDesc">Ordre du jour / description <small>(facultatif)</small></label><textarea id="rvDesc"></textarea></div>
  <details><summary>Options avancées</summary>
   <label class="rv-opt"><input type="checkbox" id="rvResp" checked> Demander une réponse (Oui / Non / Peut-être)</label>
   <label class="rv-opt"><input type="checkbox" id="rvMask"> Masquer la liste des participants aux invités</label>
   <label class="rv-opt"><input type="checkbox" id="rvInv" checked> Autoriser les invités à inviter d’autres personnes</label>
  </details>
 </div>
 <div class="rv-col">
  <button type="button" class="rv-btn ai" id="rvAi">✨ Trouver le meilleur créneau</button>
  <div class="rv-sug" id="rvSug" hidden></div>
  <div>
   <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><span class="rv-l" style="margin:0">Participants <span id="rvCnt"></span></span>
    <label class="rv-chip" style="display:inline-flex;align-items:center;gap:6px;margin:0"><input type="checkbox" id="rvTous"> Toute l’équipe</label></div>
   <div id="rvPart" style="display:grid;gap:8px">
    <div class="rv-pf"><input id="rvQ" type="search" placeholder="Rechercher un nom…"><select id="rvSpec"><option value="">Toutes les spécialités</option></select></div>
    <div class="rv-chips"><button type="button" class="rv-chip" id="rvAll">+ Ajouter les résultats (obligatoires)</button><button type="button" class="rv-chip" id="rvClr">Vider</button><label class="rv-chip" style="display:inline-flex;align-items:center;gap:6px;margin:0"><input type="checkbox" id="rvFree"> Libres seulement</label></div>
    <div class="rv-list" id="rvList"></div>
   </div>
  </div>
  <div><span class="rv-l">Disponibilités sur le créneau</span><div class="rv-tl" id="rvTL"></div>
   <div class="rv-leg" style="margin-top:6px"><span><i class="rv-dot"></i>Libre</span><span><i class="rv-dot soft"></i>En poste</span><span><i class="rv-dot hard"></i>Indisponible (congé / réunion)</span></div></div>
  <p class="rv-hint">Vous (organisateur) êtes ajouté(e) automatiquement et votre présence est confirmée.</p>
 </div>
</div>
<div class="rv-f"><button type="button" class="rv-btn dng" id="rvDel" hidden>Supprimer</button><button type="button" class="rv-btn" id="rvCancel">Annuler</button><button type="button" class="rv-btn pri" id="rvSave">Envoyer les invitations</button></div>`;

/* ===================================================================== */
export function initReunions(o) {
  const me = () => o.getMe() || {}, users = () => o.getUsers() || [], affs = () => o.getAffs() || [], evts = () => o.getEvts() || [];
  const notify = (m, t) => o.notify && o.notify(m, t);
  const peutCreer = () => me().pages?.creerRDV === true;
  const nomDe = u => users().find(x => x.uid === u)?.nom || u;
  const st = { id: null, mand: new Set(), opt: new Set(), dur: 60 };

  /* ----- notifications messagerie (création / modification / suppression) ----- */
  const envoyer = (u, t, c, r) => envoyerNotif(o, u, t, c, r, nomDe(u));
  const lieuTxt = ev => ev.mode === 'distanciel' ? 'En visio' : ((ev.lieu || 'Non précisé') + (ev.mode === 'hybride' ? ' + visio' : ''));
  const destDe = ev => [...new Set(ev.tous ? users().map(u => u.uid) : (ev.participants || []))].filter(u => u && u !== me().uid);
  const detailReunion = (ev, uid) => {
    const L = [`Quand : ${quand(ev)}`, `Horaire : ${ev.start}–${ev.end}`, `Lieu : ${lieuTxt(ev)}`];
    if (ev.lien) L.push('Visio : ' + ev.lien);
    L.push('Organisateur : ' + (ev.creeParNom || nomDe(ev.creePar) || '—'));
    if (!ev.tous) {
      if ((ev.participantsMandatory || []).includes(uid)) L.push('Participation : obligatoire');
      else if ((ev.participantsOptional || []).includes(uid)) L.push('Participation : facultative');
    }
    if (ev.description) L.push('Ordre du jour : ' + ev.description.slice(0, 200) + (ev.description.length > 200 ? '…' : ''));
    return L.join('\n');
  };
  const changements = (a, b) => {
    const L = [];
    if (a.titre !== b.titre) L.push(`Titre : ${a.titre} → ${b.titre}`);
    if (quand(a) !== quand(b)) L.push(`Date : ${quand(a)} → ${quand(b)}`);
    if (a.start !== b.start || a.end !== b.end) L.push(`Horaire : ${a.start}–${a.end} → ${b.start}–${b.end}`);
    if (lieuTxt(a) !== lieuTxt(b)) L.push(`Lieu : ${lieuTxt(a)} → ${lieuTxt(b)}`);
    if ((a.lien || '') !== (b.lien || '')) L.push('Lien visio modifié');
    if ((a.description || '') !== (b.description || '')) L.push('Ordre du jour modifié');
    return L;
  };
  function notifierReunion(avantEv, apresEv) {
    const par = me().nom || '—', ref = { type: 'evenement', id: (apresEv || avantEv)?.id || null };
    if (!apresEv) {                                   // suppression
      destDe(avantEv).forEach(u => envoyer(u, '🗑️ Réunion annulée : ' + avantEv.titre,
        `Quand : ${quand(avantEv)}\nHoraire : ${avantEv.start}–${avantEv.end}\nAnnulée par : ${par}`, ref));
      return;
    }
    const apres = new Set(destDe(apresEv)), avant = new Set(avantEv ? destDe(avantEv) : []);
    const chg = avantEv ? changements(avantEv, apresEv) : [];
    apres.forEach(u => {
      if (!avantEv || !avant.has(u)) envoyer(u, '📅 Nouvelle réunion : ' + apresEv.titre, detailReunion(apresEv, u), ref);
      else if (chg.length) envoyer(u, '✏️ Réunion modifiée : ' + apresEv.titre,
        'Modifications :\n• ' + chg.join('\n• ') + '\n\n' + detailReunion(apresEv, u) + '\nModifiée par : ' + par, ref);
    });
    avant.forEach(u => { if (!apres.has(u)) envoyer(u, '🚫 Retrait de la réunion : ' + avantEv.titre,
      `Vous n’êtes plus invité(e).\nQuand : ${quand(avantEv)}\nHoraire : ${avantEv.start}–${avantEv.end}\nPar : ${par}`, ref) });
  }

  if (!document.getElementById('rvStyle')) { const s = document.createElement('style'); s.id = 'rvStyle'; s.textContent = CSS; document.head.appendChild(s) }
  const dlg = document.createElement('dialog'); dlg.className = 'rv'; dlg.id = 'rvDlg'; dlg.innerHTML = HTML; document.body.appendChild(dlg);
  const q = s => dlg.querySelector(s);

  q('#rvDur').innerHTML = [15, 30, 45, 60, 90, 120].map(m => `<button type="button" class="rv-chip" data-m="${m}">${m < 60 ? m + ' min' : (m % 60 ? Math.floor(m / 60) + ' h ' + (m % 60) : m / 60 + ' h')}</button>`).join('');
  q('#rvDays').innerHTML = [1, 2, 3, 4, 5, 6, 0].map(d => `<button type="button" class="rv-chip" data-d="${d}">${JS[d]}</button>`).join('');

  /* ----- disponibilités ----- */
  const occupations = (uid, k, ignore) => {
    const out = [];
    for (const a of affs()) if (a.uid === uid && applique(a, k)) out.push({ s: tm(a.start), e: tm(a.end), txt: a.posteLabel || a.poste || 'Affectation', hard: a.poste === 'conge' });
    for (const ev of evts()) if (ev.id !== ignore && (ev.tous || (ev.participants || []).includes(uid)) && ev.responses?.[uid] !== 'non' && applique(ev, k)) out.push({ s: tm(ev.start), e: tm(ev.end), txt: 'Réunion : ' + ev.titre, hard: true });
    return out;
  };
  const statut = (uid, k, s, e) => {
    const c = occupations(uid, k, st.id).filter(x => x.s < e && s < x.e);
    if (c.some(x => x.hard)) return { etat: 'hard', txt: c.find(x => x.hard).txt };
    if (c.length) return { etat: 'soft', txt: c[0].txt };
    return { etat: 'free', txt: 'Libre' };
  };
  const cfg = () => {
    const rep = q('#rvRep').value, d1 = q('#rvD1').value, d2 = q('#rvD2').value;
    return { rep, d1, d2, s: tm(q('#rvS').value), e: tm(q('#rvE').value), jours: [...q('#rvDays').querySelectorAll('.on')].map(b => +b.dataset.d), tous: q('#rvTous').checked };
  };
  const datesDe = c => {
    if (!c.d1) return [];
    const out = [], d = new Date(c.d1 + 'T12:00');
    if (c.rep === 'once') return [c.d1];
    const fin = c.d2 ? new Date(c.d2 + 'T12:00') : new Date(d.getTime() + 84 * 864e5);
    for (let i = 0; i < 90 && d <= fin; i++, d.setDate(d.getDate() + 1)) {
      if (c.rep === 'range' || c.jours.includes(d.getDay())) out.push(iso(d));
    }
    return out.slice(0, 60);
  };
  const salleConflit = (k, s, e) => {
    const lieu = norm(q('#rvLieu').value.trim());
    if (!lieu || q('#rvMode').value === 'distanciel' || !k) return null;
    return evts().find(ev => ev.id !== st.id && ev.mode !== 'distanciel' && norm(ev.lieu || '') === lieu && applique(ev, k) && tm(ev.start) < e && s < tm(ev.end));
  };

  /* ----- rendu ----- */
  function rendreParts() {
    const c = cfg(), txt = norm(q('#rvQ').value), sp = q('#rvSpec').value, libre = q('#rvFree').checked, ok = c.d1 && c.e > c.s;
    let L = users().filter(u => u.uid !== me().uid && (!txt || norm(u.nom + ' ' + u.specialite).includes(txt)) && (!sp || u.specialite === sp));
    L = L.map(u => ({ u, s: ok ? statut(u.uid, c.d1, c.s, c.e) : { etat: 'free', txt: 'Libre' } }));
    if (libre) L = L.filter(x => x.s.etat === 'free' || st.mand.has(x.u.uid) || st.opt.has(x.u.uid));
    L.sort((a, b) => (st.mand.has(b.u.uid) + st.opt.has(b.u.uid)) - (st.mand.has(a.u.uid) + st.opt.has(a.u.uid)) || a.u.nom.localeCompare(b.u.nom, 'fr'));
    q('#rvAll').dataset.n = L.length;
    const MAX = 60, shown = L.slice(0, MAX);
    q('#rvList').innerHTML = shown.map(({ u, s }) => {
      const m = st.mand.has(u.uid), op = st.opt.has(u.uid);
      return `<div class="rv-it ${m || op ? 'sel' : ''}" data-uid="${esc(u.uid)}"><div class="rv-in"><b>${esc(u.nom)}</b><small><i class="rv-dot ${s.etat === 'free' ? '' : s.etat}"></i>${s.etat === 'free' ? 'Libre' : s.etat === 'soft' ? 'En poste · ' + esc(s.txt) : 'Indisponible · ' + esc(s.txt)}${u.specialite ? ' · ' + esc(u.specialite) : ''}</small></div>
      <div class="rv-rl"><button type="button" class="rv-rb ${m ? 'm' : ''}" data-r="m">Oblig.</button><button type="button" class="rv-rb ${op ? 'o' : ''}" data-r="o">Facult.</button></div></div>`;
    }).join('') || '<p class="rv-hint" style="padding:10px;text-align:center">Aucun membre trouvé.</p>';
    if (L.length > MAX) q('#rvList').insertAdjacentHTML('beforeend', `<p class="rv-hint" style="text-align:center;padding:6px">+ ${L.length - MAX} autres — affinez la recherche ou la spécialité.</p>`);
    const nm = st.mand.size, no = st.opt.size;
    q('#rvCnt').textContent = c.tous ? '· toute l’équipe' : `· ${nm} oblig. · ${no} facult.`;
    q('#rvPart').style.opacity = c.tous ? '.4' : '1'; q('#rvPart').style.pointerEvents = c.tous ? 'none' : 'auto';
  }
  function rendreTL() {
    const c = cfg(), box = q('#rvTL');
    if (!c.d1 || !(c.e > c.s)) { box.innerHTML = '<p class="rv-hint">Renseignez la date et les horaires.</p>'; return }
    if (c.tous) {
      const n = users().filter(u => statut(u.uid, c.d1, c.s, c.e).etat === 'hard').length;
      box.innerHTML = `<p class="rv-hint">Toute l’équipe (${users().length} personnes) — <b>${n}</b> indisponible${n > 1 ? 's' : ''} sur ce créneau.</p>`; return;
    }
    const H0 = 420, H1 = 1200, pc = m => Math.max(0, Math.min(100, (m - H0) / (H1 - H0) * 100));
    const rows = [...[...st.mand].map(u => [u, 1]), ...[...st.opt].map(u => [u, 0])];
    if (!rows.length) { box.innerHTML = '<p class="rv-hint">Ajoutez des participants pour voir leurs disponibilités.</p>'; return }
    const win = `<span class="rv-win" style="left:${pc(c.s)}%;width:${Math.max(1.2, pc(c.e) - pc(c.s))}%"></span>`;
    let h = '<div class="rv-tr"><span></span><div class="rv-ax">' + [8, 10, 12, 14, 16, 18, 20].map(x => `<span style="left:${pc(x * 60)}%">${x}h</span>`).join('') + '</div></div>';
    h += rows.slice(0, 10).map(([u, ob]) => `<div class="rv-tr"><span class="rv-tn" title="${esc(nomDe(u))}">${esc(nomDe(u))}${ob ? '' : ' <i>fac.</i>'}</span><div class="rv-trk">`
      + occupations(u, c.d1, st.id).map(x => `<span class="rv-bl ${x.hard ? 'hard' : ''}" title="${esc(x.txt + ' ' + hm(x.s) + '–' + hm(x.e))}" style="left:${pc(x.s)}%;width:${Math.max(.8, pc(x.e) - pc(x.s))}%"></span>`).join('') + win + '</div></div>').join('');
    if (rows.length > 10) h += `<p class="rv-hint">+ ${rows.length - 10} autre(s) participant(s)</p>`;
    box.innerHTML = h;
  }
  function majSalle() {
    const c = cfg(), w = q('#rvSalle'), x = c.e > c.s ? salleConflit(c.d1, c.s, c.e) : null;
    w.hidden = !x; if (x) w.textContent = `⚠ Salle déjà réservée : « ${x.titre} » ${x.start}–${x.end}`;
  }
  const maj = () => { rendreParts(); rendreTL(); majSalle(); majDur() };
  function majDur() {
    const c = cfg(), d = c.e - c.s;
    q('#rvDur').querySelectorAll('.rv-chip').forEach(b => b.classList.toggle('on', +b.dataset.m === d));
  }
  function syncRep() {
    const r = q('#rvRep').value;
    q('#rvD2Box').hidden = r === 'once'; q('#rvDaysBox').hidden = r !== 'weekly';
    q('#rvD2L').textContent = r === 'weekly' ? 'Jusqu’au (facultatif)' : 'Au (inclus)';
    if (r === 'weekly' && !q('#rvDays .on') && q('#rvD1').value) q(`#rvDays [data-d="${new Date(q('#rvD1').value + 'T12:00').getDay()}"]`)?.classList.add('on');
  }
  function syncMode() { const m = q('#rvMode').value; q('#rvLieuBox').hidden = m === 'distanciel'; q('#rvLienBox').hidden = m === 'presentiel' }

  /* ----- assistant : meilleur créneau ----- */
  function suggerer() {
    const c = cfg(), box = q('#rvSug'), must = c.tous ? users().map(u => u.uid) : [...st.mand], opt = c.tous ? [] : [...st.opt];
    box.hidden = false;
    if (!must.length) { box.innerHTML = '<p class="rv-hint">Ajoutez au moins un participant <b>obligatoire</b> pour calculer les meilleurs créneaux.</p>'; return }
    const dur = c.e > c.s ? c.e - c.s : 60, res = [], start = c.d1 || iso(new Date());
    for (let i = 0; i < 21; i++) {
      const d = new Date(start + 'T12:00'); d.setDate(d.getDate() + i);
      if (d.getDay() === 0 || d.getDay() === 6) continue;
      const k = iso(d), occ = new Map([...must, ...opt].map(u => [u, occupations(u, k, st.id)]));
      for (let t = 480; t + dur <= 1140; t += 15) {
        let hard = 0, soft = 0, oh = 0;
        for (const u of must) { const x = occ.get(u).filter(z => z.s < t + dur && t < z.e); if (x.some(z => z.hard)) hard++; else if (x.length) soft++ }
        for (const u of opt) { if (occ.get(u).some(z => z.hard && z.s < t + dur && t < z.e)) oh++ }
        const score = hard * 1000 + soft * 25 + oh * 8 + i * 4 + (t < 540 || t >= 1080 ? 5 : 0) + (t >= 720 && t < 810 ? 7 : 0);
        res.push({ k, t, hard, soft, oh, score });
      }
    }
    res.sort((a, b) => a.score - b.score);
    const pick = [];
    for (const r of res) { if (pick.length >= 5) break; if (!pick.some(p => p.k === r.k && Math.abs(p.t - r.t) < Math.max(60, dur))) pick.push(r) }
    box.innerHTML = '<span class="rv-l" style="margin:0">Créneaux recommandés (' + dur + ' min)</span>' + pick.map(r => {
      const n = must.length, okN = n - r.hard, cls = r.hard === 0 ? '' : r.hard <= Math.ceil(n / 4) ? 'mid' : 'bad';
      return `<button type="button" class="rv-sg" data-k="${r.k}" data-t="${r.t}"><span><b>${new Date(r.k + 'T12:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })}</b><small>${hm(r.t)} – ${hm(r.t + dur)}${r.oh ? ' · ' + r.oh + ' facultatif(s) absent(s)' : ''}${r.soft ? ' · ' + r.soft + ' en poste' : ''}</small></span><span class="rv-ok ${cls}">${okN}/${n} dispo</span></button>`;
    }).join('');
  }

  /* ----- événements UI ----- */
  q('#rvX').onclick = q('#rvCancel').onclick = () => dlg.close();
  ['#rvD1', '#rvD2', '#rvE', '#rvMode', '#rvLieu'].forEach(s => q(s).addEventListener('input', maj));
  q('#rvS').addEventListener('input', () => { const s = tm(q('#rvS').value); if (!isNaN(s) && st.dur) q('#rvE').value = hm(Math.min(s + st.dur, 1439)); maj() });
  q('#rvE').addEventListener('input', () => { const d = tm(q('#rvE').value) - tm(q('#rvS').value); if (d > 0) st.dur = d });
  q('#rvD1').addEventListener('input', syncRep);
  q('#rvRep').onchange = () => { syncRep(); maj() };
  q('#rvMode').onchange = () => { syncMode(); maj() };
  q('#rvDur').onclick = e => { const b = e.target.closest('[data-m]'); if (!b) return; st.dur = +b.dataset.m; const s = tm(q('#rvS').value); if (!isNaN(s)) q('#rvE').value = hm(Math.min(s + st.dur, 1439)); maj() };
  q('#rvDays').onclick = e => { const b = e.target.closest('[data-d]'); if (b) { b.classList.toggle('on'); maj() } };
  q('#rvGen').onclick = () => { const a = new Uint8Array(6); crypto.getRandomValues(a); q('#rvLien').value = 'https://meet.jit.si/GestUrg-' + [...a].map(x => x.toString(36).padStart(2, '0')).join('') };
  q('#rvTous').onchange = maj; q('#rvFree').onchange = rendreParts; q('#rvSpec').onchange = rendreParts; q('#rvQ').oninput = rendreParts;
  q('#rvAi').onclick = suggerer;
  q('#rvSug').onclick = e => {
    const b = e.target.closest('.rv-sg'); if (!b) return;
    const dur = tm(q('#rvE').value) - tm(q('#rvS').value) || st.dur || 60, t = +b.dataset.t;
    q('#rvD1').value = b.dataset.k; q('#rvS').value = hm(t); q('#rvE').value = hm(t + dur); syncRep(); maj();
    q('#rvSug').hidden = true;
  };
  q('#rvList').onclick = e => {
    const b = e.target.closest('[data-r]'), it = e.target.closest('[data-uid]'); if (!b || !it) return;
    const u = it.dataset.uid, [a, z] = b.dataset.r === 'm' ? [st.mand, st.opt] : [st.opt, st.mand];
    a.has(u) ? a.delete(u) : (a.add(u), z.delete(u)); maj();
  };
  q('#rvAll').onclick = () => {
    const c = cfg(), txt = norm(q('#rvQ').value), sp = q('#rvSpec').value;
    users().filter(u => u.uid !== me().uid && (!txt || norm(u.nom + ' ' + u.specialite).includes(txt)) && (!sp || u.specialite === sp)
      && (!q('#rvFree').checked || statut(u.uid, c.d1, c.s, c.e).etat === 'free')).forEach(u => { st.mand.add(u.uid); st.opt.delete(u.uid) });
    maj();
  };
  q('#rvClr').onclick = () => { st.mand.clear(); st.opt.clear(); maj() };

  /* ----- ouverture ----- */
  async function ouvrir(ev, pre = {}) {
    if (!peutCreer()) { notify('Vous n’avez pas le droit de créer ou modifier des réunions (droit « creerRDV » requis).', 'avertissement'); return }
    try { o.refresh && await o.refresh() } catch (e) { console.warn(e) }
    st.id = ev?.id || null;
    const d = pre.date || iso(new Date()), rep = ev ? (ev.jours ? 'weekly' : (ev.dateFin && ev.dateFin !== ev.date ? 'range' : 'once')) : 'once';
    q('#rvT').textContent = ev ? 'Modifier la réunion' : 'Nouvelle réunion';
    q('#rvSave').textContent = ev ? 'Enregistrer & notifier' : 'Envoyer les invitations';
    q('#rvTitre').value = ev?.titre || ''; q('#rvCat').value = ev?.cat || 'reunion';
    q('#rvRep').value = rep;
    q('#rvD1').value = ev ? (ev.date || ev.depuis || d) : d;
    q('#rvD2').value = ev ? (ev.dateFin || ev.jusqu || '') : '';
    q('#rvS').value = ev?.start || pre.start || '14:00'; q('#rvE').value = ev?.end || pre.end || '15:00';
    st.dur = tm(q('#rvE').value) - tm(q('#rvS').value) || 60;
    q('#rvDays').querySelectorAll('.rv-chip').forEach(b => b.classList.toggle('on', !!ev?.jours?.includes(+b.dataset.d)));
    q('#rvMode').value = ev?.mode || 'presentiel'; q('#rvLieu').value = ev?.lieu || ''; q('#rvLien').value = ev?.lien || '';
    q('#rvRap').value = String(ev?.rappel ?? 15); q('#rvDesc').value = ev?.description || '';
    q('#rvResp').checked = ev?.optResponse ?? true; q('#rvMask').checked = ev?.optMaskList ?? false; q('#rvInv').checked = ev?.optInvite ?? true;
    q('#rvTous').checked = !!ev?.tous;
    st.mand = new Set(ev?.participantsMandatory || []); st.opt = new Set(ev?.participantsOptional || []);
    st.mand.delete(me().uid); st.opt.delete(me().uid);
    q('#rvQ').value = ''; q('#rvFree').checked = false; q('#rvSug').hidden = true;
    const specs = [...new Set(users().map(u => u.specialite).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'fr'));
    q('#rvSpec').innerHTML = '<option value="">Toutes les spécialités</option>' + specs.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    q('#rvRooms').innerHTML = [...new Set(evts().map(e => e.lieu).filter(Boolean))].map(l => `<option value="${esc(l)}">`).join('');
    q('#rvDel').hidden = !ev;
    syncRep(); syncMode(); maj();
    dlg.showModal();
  }

  /* ----- enregistrement ----- */
  q('#rvSave').onclick = async () => {
    if (!peutCreer()) return notify('Droit « creerRDV » requis.', 'avertissement');
    const c = cfg(), titre = q('#rvTitre').value.trim(), mode = q('#rvMode').value;
    if (!titre) return notify('Saisissez un titre', 'avertissement');
    if (!c.d1) return notify('Choisissez une date', 'avertissement');
    if (!(c.e > c.s)) return notify('Horaires invalides (la fin doit suivre le début)', 'avertissement');
    if (c.rep === 'range' && (!c.d2 || c.d2 < c.d1)) return notify('Dates invalides', 'avertissement');
    if (c.rep === 'weekly' && !c.jours.length) return notify('Choisissez au moins un jour de la semaine', 'avertissement');
    if (c.rep === 'weekly' && c.d2 && c.d2 < c.d1) return notify('Dates invalides', 'avertissement');
    if (mode !== 'presentiel' && q('#rvLien').value.trim() && !/^https?:\/\//i.test(q('#rvLien').value.trim())) return notify('Le lien visio doit commencer par http(s)://', 'avertissement');

    const dates = datesDe(c), cibles = c.tous ? users().map(u => u.uid) : [...st.mand];
    const indispo = cibles.filter(u => dates.slice(0, 30).some(k => occupations(u, k, st.id).some(x => x.hard && x.s < c.e && c.s < x.e)));
    if (indispo.length && !confirm(`${indispo.length} participant(s) obligatoire(s) indisponible(s) sur ce créneau :\n• ${indispo.slice(0, 8).map(nomDe).join('\n• ')}${indispo.length > 8 ? '\n• …' : ''}\n\nEnvoyer quand même ?`)) return;
    const sl = dates.slice(0, 30).map(k => salleConflit(k, c.s, c.e)).find(Boolean);
    if (sl && !confirm(`La salle « ${sl.lieu} » est déjà réservée (« ${sl.titre} » ${sl.start}–${sl.end}). Continuer ?`)) return;

    const old = st.id ? evts().find(x => x.id === st.id) : null, mand = [...st.mand], opt = [...st.opt];
    const weekly = c.rep === 'weekly', range = c.rep === 'range';
    const sig = [c.rep, c.d1, c.d2, c.s, c.e, c.jours.join()].join('|');
    const oldSig = old ? [old.jours ? 'weekly' : (old.dateFin && old.dateFin !== old.date ? 'range' : 'once'), old.date || old.depuis, old.dateFin || old.jusqu || '', tm(old.start), tm(old.end), (old.jours || []).join()].join('|') : '';
    const responses = old && sig === oldSig ? { ...(old.responses || {}) } : {};
    responses[me().uid] = 'oui';
    const payload = {
      cat: q('#rvCat').value, titre, mode,
      date: weekly ? null : c.d1, dateFin: range ? c.d2 : null,
      jours: weekly ? c.jours : null, depuis: weekly ? c.d1 : null, jusqu: weekly ? (c.d2 || null) : null,
      start: q('#rvS').value, end: q('#rvE').value,
      lieu: mode === 'distanciel' ? '' : q('#rvLieu').value.trim(), lien: mode === 'presentiel' ? '' : q('#rvLien').value.trim(),
      description: q('#rvDesc').value.trim(), rappel: +q('#rvRap').value || 0,
      tous: c.tous, participantsMandatory: mand, participantsOptional: opt, participants: [...new Set([...mand, ...opt, me().uid])],
      optInvite: q('#rvInv').checked, optMaskList: q('#rvMask').checked, optResponse: q('#rvResp').checked,
      responses, creePar: old?.creePar || me().uid, creeParNom: old?.creeParNom || me().nom || ''
    };
    const btn = q('#rvSave'); btn.disabled = true;
    try {
      let evId = st.id;
      if (st.id) await updateDoc(doc(o.db, 'evenements', st.id), { ...payload, modifiePar: me().uid, modifieLe: serverTimestamp() });
      else evId = (await addDoc(collection(o.db, 'evenements'), { ...payload, creeLe: serverTimestamp() })).id;
      try { notifierReunion(old, { ...payload, id: evId }) } catch (e) { console.warn('Notification calendrier :', e) }
      dlg.close(); notify(st.id ? 'Réunion mise à jour — invités notifiés' : 'Réunion créée — invitations envoyées', 'succes');
      o.onSaved && o.onSaved();
    } catch (err) { console.error(err); notify('Échec de l’enregistrement (droits Firestore ?)', 'erreur') }
    btn.disabled = false;
  };
  q('#rvDel').onclick = async () => {
    if (!peutCreer() || !st.id || !confirm('Supprimer cette réunion pour tous les invités ?')) return;
    const ancien = evts().find(x => x.id === st.id);
    try { await deleteDoc(doc(o.db, 'evenements', st.id)); try { ancien && notifierReunion(ancien, null) } catch (e) { console.warn('Notification calendrier :', e) } dlg.close(); notify('Réunion supprimée', 'succes'); o.onSaved && o.onSaved() }
    catch (e) { console.error(e); notify('Échec de la suppression', 'erreur') }
  };

  return { ouvrir, peutCreer };
}