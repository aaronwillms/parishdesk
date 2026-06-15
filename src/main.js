import './styles/main.css';
import { initAuth } from './auth.js';
import { initLiturgical } from './liturgical.js';
import { loadCalendar, loadInit } from './panels/dashboard.js';
import { initNavigation } from './ui/navigation.js';
import { initModal } from './ui/modal.js';
import { openCoupleAdd, loadCouples } from './panels/marriage.js';
import { caseForm, loadCases } from './panels/annulments.js';
import { projectForm, loadProjects } from './panels/projects.js';
import { loadSacramental } from './panels/sacramental.js';
import { loadOcia } from './panels/ocia.js';
import { loadCoordData } from './ui/coordinator.js';
import { loadSchool } from './panels/school.js';
import { loadPersonnel } from './panels/personnel.js';
import { initNotifications } from './notifications.js';

async function startApp(user) {
  window.openModal = (type, defaultStatus) => {
    if (type === 'couple') { openCoupleAdd(); return; }
    let html;
    if (type === 'case')    html = caseForm();
    if (type === 'project') html = projectForm(defaultStatus);
    if (!html) return;
    document.getElementById('modal-content').innerHTML = html;
    document.getElementById('modal-overlay').classList.add('open');
  };

  initNavigation({
    marriage:     () => { loadCouples(); loadCoordData('marriage'); },
    annulments:   loadCases,
    projects:     loadProjects,
    personnel:    loadPersonnel,
    school:       loadSchool,
    baptism:      () => { loadSacramental('baptism');      loadCoordData('baptism'); },
    firstcomm:    () => { loadSacramental('firstcomm');    loadCoordData('firstcomm'); },
    confirmation: () => { loadSacramental('confirmation'); loadCoordData('confirmation'); },
    ocia:         () => { loadOcia(); loadCoordData('ocia'); },
  });

  initModal();
  initLiturgical();
  loadCalendar();
  await Promise.all([loadInit(), loadPersonnel()]);
  if (user?.id) initNotifications(user.id);
}

(async () => {
  const user = await initAuth(startApp);
  if (user) startApp(user);
})();
