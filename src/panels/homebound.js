import { stubPanel } from '../ui/stubPanel.js';

export function loadHomebound() {
  stubPanel('homebound-root', {
    icon: 'fa-house-medical',
    title: 'Sick & Homebound',
    blurb: 'Coordinate visits to the sick, homebound, hospitalized, and those in care facilities — track who needs Communion, anointing, or a pastoral visit, who is assigned, and when each person was last seen.',
  });
}
