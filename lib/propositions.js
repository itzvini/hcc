'use strict';

// Canonical VAA propositions. The ids are the shared contract: they appear in the
// API responses, the stored applications, and (later) the voter match. The English
// statement TEXT lives once in locales/en.json under "prop.<id>" — the client renders
// from there, and the derivation helper reads it for the model prompt. Editing the
// wording = edit en.json; changing/adding a proposition = edit this list.
//
// NOTE: statements are a first-draft distilled from community questions — owner to refine.
const PROPOSITIONS = [
  { id: 'quality',      axis: 'Drops' },
  { id: 'exclusivity',  axis: 'Holder items' },
  { id: 'gen2bold',     axis: 'Gen 2' },
  { id: 'gen2focus',    axis: 'Roadmap' },
  { id: 'transparency', axis: 'Communication' },
  { id: 'newholders',   axis: 'Representation' },
  { id: 'smallholders', axis: 'Representation' },
  { id: 'pushback',     axis: 'Pocket Worlds' },
  { id: 'mandate',      axis: 'Council power' },
];

const PROPOSITION_IDS = PROPOSITIONS.map(p => p.id);

module.exports = { PROPOSITIONS, PROPOSITION_IDS };
