'use strict';

// Canonical VAA propositions. The ids are the shared contract: they appear in the
// API responses, the stored applications, and (later) the voter match. The English
// statement TEXT lives once in locales/en.json under "prop.<id>" — the client renders
// from there, and the derivation helper reads it for the model prompt. Editing the
// wording = edit en.json; changing/adding a proposition = edit this list.
//
// NOTE: statements are a first-draft distilled from community questions — owner to refine.
const PROPOSITIONS = [
  { id: 'scarcity',     axis: 'Economy' },
  { id: 'cadence',      axis: 'Drops' },
  { id: 'pushback',     axis: 'Pocket Worlds' },
  { id: 'longterm',     axis: 'Strategy' },
  { id: 'smallholders', axis: 'Representation' },
  { id: 'transparency', axis: 'Governance' },
  { id: 'floor',        axis: 'Success metric' },
  { id: 'tradition',    axis: 'Identity' },
  { id: 'power',        axis: 'Mandate' },
];

const PROPOSITION_IDS = PROPOSITIONS.map(p => p.id);

module.exports = { PROPOSITIONS, PROPOSITION_IDS };
