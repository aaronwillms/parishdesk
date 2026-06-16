import { store } from './store.js';

const OPT_MEMORIALS = {
  '1-13':'Optional Memorial of St. Hilary, Bishop & Doctor','1-17':'Optional Memorial of St. Anthony, Abbot',
  '1-20':'Optional Memorial of St. Fabian, Pope & Martyr','1-21':'Optional Memorial of St. Agnes, Virgin & Martyr',
  '1-24':'Memorial of St. Francis de Sales, Bishop & Doctor','1-26':'Memorial of Sts. Timothy & Titus, Bishops',
  '1-27':'Optional Memorial of St. Angela Merici, Virgin','1-28':'Memorial of St. Thomas Aquinas, Priest & Doctor',
  '1-31':'Memorial of St. John Bosco, Priest','2-5':'Memorial of St. Agatha, Virgin & Martyr',
  '2-6':'Memorial of Sts. Paul Miki & Companions, Martyrs','2-10':'Memorial of St. Scholastica, Virgin',
  '2-11':'Optional Memorial of Our Lady of Lourdes','2-14':'Memorial of Sts. Cyril & Methodius',
  '2-22':'Feast of the Chair of St. Peter, Apostle','2-23':'Feast of the Dedication of the Cathedral of Saint Peter the Apostle',
  '3-7':'Memorial of Sts. Perpetua & Felicity, Martyrs','3-19':'Solemnity of St. Joseph',
  '4-7':'Memorial of St. John Baptist de la Salle, Priest','4-11':'Memorial of St. Stanislaus, Bishop & Martyr',
  '4-25':'Feast of St. Mark, Evangelist','4-29':'Memorial of St. Catherine of Siena, Virgin & Doctor',
  '5-2':'Memorial of St. Athanasius, Bishop & Doctor','5-3':'Feast of Sts. Philip & James, Apostles',
  '5-13':'Optional Memorial of Our Lady of Fatima','5-14':'Feast of St. Matthias, Apostle',
  '5-26':'Memorial of St. Philip Neri, Priest','5-31':'Feast of the Visitation of the Blessed Virgin Mary',
  '6-1':'Optional Memorial of St. Justin, Martyr','6-3':'Memorial of St. Charles Lwanga & Companions, Martyrs',
  '6-5':'Memorial of St. Boniface, Bishop & Martyr','6-11':'Memorial of St. Barnabas, Apostle',
  '6-13':'Memorial of St. Anthony of Padua, Priest & Doctor','6-21':'Memorial of St. Aloysius Gonzaga, Religious',
  '6-24':'Solemnity of the Nativity of St. John the Baptist','6-28':'Solemnity of Sts. Peter & Paul, Apostles',
  '6-29':'Feast of Sts. Peter & Paul, Apostles (if not Sunday)',
  '7-3':'Feast of St. Thomas, Apostle','7-11':'Memorial of St. Benedict, Abbot',
  '7-15':'Memorial of St. Bonaventure, Bishop & Doctor','7-22':'Feast of St. Mary Magdalene',
  '7-25':'Feast of St. James, Apostle','7-26':'Memorial of Sts. Joachim & Anne',
  '7-29':'Memorial of St. Martha, Mary & Lazarus','7-31':'Memorial of St. Ignatius of Loyola, Priest',
  '8-1':'Memorial of St. Alphonsus Liguori, Bishop & Doctor','8-4':'Memorial of St. John Vianney, Priest',
  '8-6':'Feast of the Transfiguration of the Lord','8-8':'Memorial of St. Dominic, Priest',
  '8-10':'Feast of St. Lawrence, Deacon & Martyr','8-11':'Memorial of St. Clare, Virgin',
  '8-15':'Solemnity of the Assumption of the Blessed Virgin Mary',
  '8-20':'Memorial of St. Bernard, Abbot & Doctor','8-21':'Memorial of St. Pius X, Pope',
  '8-22':'Memorial of the Queenship of the Blessed Virgin Mary',
  '8-24':'Feast of St. Bartholomew, Apostle','8-27':'Memorial of St. Monica',
  '8-28':'Memorial of St. Augustine, Bishop & Doctor','8-29':'Memorial of the Passion of St. John the Baptist',
  '9-3':'Memorial of St. Gregory the Great, Pope & Doctor','9-8':'Feast of the Nativity of the Blessed Virgin Mary',
  '9-13':'Memorial of St. John Chrysostom, Bishop & Doctor',
  '9-15':'Solemnity of Our Lady of Sorrows (parish)','9-16':'Memorial of Sts. Cornelius & Cyprian, Martyrs',
  '9-21':'Feast of St. Matthew, Apostle & Evangelist','9-23':'Memorial of St. Pius of Pietrelcina, Priest',
  '9-27':'Memorial of St. Vincent de Paul, Priest','9-29':'Feast of Sts. Michael, Gabriel & Raphael, Archangels',
  '9-30':'Memorial of St. Jerome, Priest & Doctor',
  '10-1':'Memorial of St. Thérèse of the Child Jesus, Virgin & Doctor',
  '10-2':'Memorial of the Holy Guardian Angels','10-4':'Memorial of St. Francis of Assisi',
  '10-7':'Memorial of Our Lady of the Rosary','10-15':'Memorial of St. Teresa of Ávila, Virgin & Doctor',
  '10-17':'Memorial of St. Ignatius of Antioch, Bishop & Martyr','10-18':'Feast of St. Luke, Evangelist',
  '10-28':'Feast of Sts. Simon & Jude, Apostles',
  '11-1':'Solemnity of All Saints','11-2':'The Commemoration of All the Faithful Departed',
  '11-4':'Memorial of St. Charles Borromeo, Bishop','11-9':'Feast of the Dedication of the Lateran Basilica',
  '11-10':'Memorial of St. Leo the Great, Pope & Doctor','11-11':'Memorial of St. Martin of Tours, Bishop',
  '11-17':'Memorial of St. Elizabeth of Hungary, Religious',
  '11-21':'Memorial of the Presentation of the Blessed Virgin Mary',
  '11-22':'Memorial of St. Cecilia, Virgin & Martyr','11-30':'Feast of St. Andrew, Apostle',
  '12-3':'Memorial of St. Francis Xavier, Priest','12-7':'Memorial of St. Ambrose, Bishop & Doctor',
  '12-8':'Solemnity of the Immaculate Conception','12-12':'Feast of Our Lady of Guadalupe',
  '12-13':'Memorial of St. Lucy, Virgin & Martyr','12-14':'Memorial of St. John of the Cross, Priest & Doctor',
  '12-26':'Feast of St. Stephen, First Martyr','12-27':'Feast of St. John, Apostle & Evangelist',
  '12-28':'Feast of the Holy Innocents, Martyrs',
};

function getLiturgicalDay(d) {
  const month=d.getMonth()+1, day=d.getDate(), dow=d.getDay();
  const dayNames=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const weekOrd=['','First','Second','Third','Fourth','Fifth','Sixth','Seventh','Eighth','Ninth','Tenth','Eleventh','Twelfth','Thirteenth','Fourteenth','Fifteenth','Sixteenth','Seventeenth','Eighteenth','Nineteenth','Twentieth','Twenty-First','Twenty-Second','Twenty-Third','Twenty-Fourth','Twenty-Fifth','Twenty-Sixth','Twenty-Seventh','Twenty-Eighth','Twenty-Ninth','Thirtieth','Thirty-First','Thirty-Second','Thirty-Third','Thirty-Fourth'];

  if(month===6&&day===14) return {name:'✠ THE MOST SACRED HEART OF JESUS',rank:'SOLEMNITY',season:'Ordinary Time',vestColor:'#C9A84C',barColor:'#C9A84C'};
  if(month===9&&day===15) return {name:'✠ OUR LADY OF SORROWS',rank:'SOLEMNITY',season:'Ordinary Time',vestColor:'#C9A84C',barColor:'#C9A84C'};

  const easter2026=new Date(2026,3,5);
  const diff=Math.floor((d-easter2026)/86400000);
  if(diff===0) return {name:'✠ EASTER SUNDAY',rank:'SOLEMNITY',season:'Easter Time',vestColor:'#C9A84C',barColor:'#C9A84C'};
  if(diff>0&&diff<49) return {name:'FERIA — EASTER TIME',rank:`${dayNames[dow]} · Easter Time`,season:'Easter Time',vestColor:'#F0EDE6',barColor:'#D4C9B0'};
  if(diff===49) return {name:'✠ PENTECOST SUNDAY',rank:'SOLEMNITY',season:'Ordinary Time',vestColor:'#8B1A2F',barColor:'#8B1A2F'};

  const lentStart=new Date(2026,1,18);
  if(d>=lentStart&&d<easter2026){
    const palmSun=new Date(2026,2,29);
    if(dow===0&&d>=palmSun) return {name:'✠ PALM SUNDAY OF THE PASSION',rank:'SUNDAY',season:'Holy Week',vestColor:'#8B1A2F',barColor:'#8B1A2F'};
    if(d>=palmSun) return {name:'HOLY WEEK',rank:`${dayNames[dow]} of Holy Week`,season:'Holy Week',vestColor:'#8B1A2F',barColor:'#8B1A2F'};
    if(month===3&&day>=15&&day<=21&&dow===0) return {name:'✠ LAETARE SUNDAY',rank:'FOURTH SUNDAY OF LENT',season:'Lent',vestColor:'#C47E9A',barColor:'#C47E9A'};
    return {name:'FERIA',rank:`${dayNames[dow]} · Lent`,season:'Lent',vestColor:'#534AB7',barColor:'#534AB7'};
  }

  const advent2025=new Date(2025,10,30), xmas=new Date(2025,11,25), baptism=new Date(2026,0,11);
  if(d>=advent2025&&d<xmas){
    const aw=Math.floor((d-advent2025)/604800000)+1;
    if(dow===0&&aw===3) return {name:'✠ GAUDETE SUNDAY',rank:'THIRD SUNDAY OF ADVENT',season:'Advent',vestColor:'#C47E9A',barColor:'#C47E9A'};
    if(dow===0) return {name:`✠ ${weekOrd[aw].toUpperCase()} SUNDAY OF ADVENT`,rank:'SUNDAY OF ADVENT',season:'Advent',vestColor:'#534AB7',barColor:'#534AB7'};
    return {name:'ADVENT',rank:`${dayNames[dow]} · Advent`,season:'Advent',vestColor:'#534AB7',barColor:'#534AB7'};
  }
  if(month===12&&day===25) return {name:'✠ THE NATIVITY OF THE LORD',rank:'SOLEMNITY',season:'Christmas',vestColor:'#C9A84C',barColor:'#C9A84C'};
  if(d>=xmas&&d<baptism) return {name:'CHRISTMAS SEASON',rank:`${dayNames[dow]} · Christmas`,season:'Christmas Time',vestColor:'#F0EDE6',barColor:'#D4C9B0'};
  if(month===11&&day===2) return {name:'THE COMMEMORATION OF ALL THE FAITHFUL DEPARTED',rank:"ALL SOULS' DAY",season:'Ordinary Time',vestColor:'#2C2C2A',barColor:'#444441'};

  const otIStart=new Date(2026,0,12);
  const pentecost=new Date(2026,4,31);
  const otIIStart=new Date(2026,5,1);
  let weekNum;
  if(d<pentecost){
    weekNum=Math.max(1,Math.min(34,Math.floor((d-otIStart)/(7*86400000))+1));
  } else {
    const daysFromOtII=Math.floor((d-otIIStart)/86400000);
    let adjustedWeek;
    if(daysFromOtII<=13){
      adjustedWeek=10;
    } else {
      adjustedWeek=11+Math.floor((daysFromOtII-14)/7);
    }
    weekNum=Math.max(1,Math.min(34,adjustedWeek));
  }
  if(dow===0) return {name:`✠ ${weekOrd[weekNum].toUpperCase()} SUNDAY OF ORDINARY TIME`,rank:'SUNDAY',season:'Ordinary Time',vestColor:'#3B6D11',barColor:'#3B6D11'};

  const key=`${month}-${day}`;
  const memorial=OPT_MEMORIALS[key]||null;
  return {name: memorial?`FERIA, ${memorial}`:'FERIA', rank:`${dayNames[dow]} of the ${weekOrd[weekNum]} Week of Ordinary Time`, season:'Ordinary Time', vestColor:'#3B6D11', barColor:'#3B6D11'};
}

export function initLiturgical() {
  const parishTz = store.parishSettings?.timezone || 'America/Chicago';
  const today = new Date(new Date().toLocaleString('en-US',{timeZone: parishTz}));
  const lit = getLiturgicalDay(today);
  const dateStr = today.toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric',timeZone: parishTz});
  document.getElementById('lit-date').textContent = dateStr;
  document.getElementById('lit-day').textContent = lit.name;
  document.getElementById('lit-rank').textContent = lit.rank;
  const dot = document.getElementById('lit-color-dot');
  dot.style.background = lit.vestColor;
  const isLight = lit.vestColor==='#F0EDE6'||lit.vestColor==='#FFFFFF';
  dot.style.borderColor = isLight?'rgba(248,247,244,0.55)':'rgba(248,247,244,0.28)';
  document.getElementById('season-bar').style.background = lit.barColor;
  const topbarSeason = document.getElementById('topbar-season');
  if(topbarSeason) topbarSeason.textContent = lit.season;
  return lit;
}
