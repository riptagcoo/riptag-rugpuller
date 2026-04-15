const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false });

async function initDB() {
  await pool.query(`CREATE TABLE IF NOT EXISTS hivemind_state (key TEXT PRIMARY KEY, value JSONB NOT NULL)`);
  console.log('[Hivemind] DB ready');
}

async function dbGet(key) {
  try { const res = await pool.query('SELECT value FROM hivemind_state WHERE key=$1',[key]); return res.rows.length?res.rows[0].value:null; }
  catch(e) { console.error('[DB]',e.message); return null; }
}

async function dbSet(key, value) {
  try { await pool.query(`INSERT INTO hivemind_state(key,value)VALUES($1,$2)ON CONFLICT(key)DO UPDATE SET value=$2`,[key,JSON.stringify(value)]); }
  catch(e) { console.error('[DB]',e.message); }
}

let runtime = { started: false, startedAt: null, status: {} };

const DEFAULT_SETTINGS = { sessionMinutes:35, maxDays:7, maxPosts:30, speedPreset:'balanced', minDelay:1500, maxDelay:4000, hesitationChance:25, hesitationDuration:3000 };
const DEFAULT_DAY_FOLDERS = { monday:{g0:'',g1:'',g2:''}, tuesday:{g0:'',g1:'',g2:''}, wednesday:{g0:'',g1:'',g2:''}, thursday:{g0:'',g1:'',g2:''}, friday:{g0:'',g1:'',g2:''} };
const DAY_NAMES = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
const GROUP_KEYS = ['g0','g1','g2'];

function getMountainTime() {
  const mst = new Date(Date.now() - 7*60*60*1000);
  return { hour:mst.getUTCHours(), minute:mst.getUTCMinutes(), day:DAY_NAMES[mst.getUTCDay()] };
}

async function autoAssignAndStart() {
  const [pcs, dayFolders] = await Promise.all([dbGet('pcs'),dbGet('dayFolders')]);
  if (!pcs||!dayFolders) return;
  const today = getMountainTime().day;
  const todayData = dayFolders[today];
  if (!todayData) return;
  let assigned = false;
  for (const [pcId,pc] of Object.entries(pcs)) {
    pc.groups.forEach((group,gIdx) => {
      const groupData = todayData[GROUP_KEYS[gIdx]];
      if (!groupData) return;
      // Old format: plain string of URLs
      if (typeof groupData === 'string') {
        if (groupData.trim()) { group.queue=groupData.split('\n').map(s=>s.trim()).filter(Boolean); assigned=true; }
      }
      // New format: array of {url, pcIds} objects with per-PC selection
      else if (Array.isArray(groupData)) {
        const filtered = groupData
          .filter(s => !s.pcIds || s.pcIds.length === 0 || s.pcIds.includes(pcId))
          .map(s => s.url)
          .filter(Boolean);
        if (filtered.length) { group.queue = filtered; assigned = true; }
      }
    });
  }
  if (!assigned) return;
  await dbSet('pcs',pcs);
  runtime.started=true; runtime.startedAt=Date.now(); runtime.status={};
  console.log(`[Scheduler] Auto-started for ${today}`);
}

let lastScheduledDay = null;
let lastStopDay = null;

function startScheduler() {
  setInterval(async () => {
    const {hour, minute, day} = getMountainTime();

    // Auto-start 7:00 PM MST weekdays
    if (hour === 19 && minute === 0 && day !== lastScheduledDay && ['monday','tuesday','wednesday','thursday','friday'].includes(day)) {
      lastScheduledDay = day;
      await autoAssignAndStart();
    }

    // Auto-stop 6:00 AM MST (11 hours after 7PM)
    if (hour === 8 && minute === 0 && day !== lastStopDay) {
      if (runtime.started) {
        lastStopDay = day;
        runtime.started = false;
        console.log('[Scheduler] Auto-stopped at 8AM MST');
      }
    }

  }, 60000);
  console.log('[Scheduler] Start 7PM / Stop 8AM MST weekdays');
}

async function getFullState() {
  const [pcs,settings,dayFolders] = await Promise.all([dbGet('pcs'),dbGet('settings'),dbGet('dayFolders')]);
  return { pcs:pcs||{}, settings:settings||DEFAULT_SETTINGS, dayFolders:dayFolders||DEFAULT_DAY_FOLDERS, started:runtime.started, startedAt:runtime.startedAt, status:runtime.status };
}

app.get('/api/state', async (req,res) => res.json(await getFullState()));

app.post('/api/pcs', async (req,res) => {
  const {pcs}=req.body; if(!pcs) return res.status(400).json({error:'missing pcs'});
  await dbSet('pcs',pcs); runtime.status={};
  res.json({ok:true});
});

app.post('/api/settings', async (req,res) => {
  const s=req.body; const current=await dbGet('settings')||DEFAULT_SETTINGS;
  await dbSet('settings',{...current,...s}); res.json({ok:true});
});

app.post('/api/dayfolders', async (req,res) => {
  const {dayFolders}=req.body; const current=await dbGet('dayFolders')||DEFAULT_DAY_FOLDERS;
  await dbSet('dayFolders',{...current,...dayFolders}); res.json({ok:true});
});

app.post('/api/start', (req,res) => { runtime.started=true; runtime.startedAt=Date.now(); res.json({ok:true}); });
app.post('/api/stop', (req,res) => { runtime.started=false; res.json({ok:true}); });
app.post('/api/scheduler/trigger', async (req,res) => { await autoAssignAndStart(); res.json({ok:true}); });

app.post('/api/scheduler/skip', (req,res) => {
  const {day} = getMountainTime();
  lastScheduledDay = day;
  console.log(`[Scheduler] Skipped for ${day}`);
  res.json({ ok: true });
});

app.get('/api/queue/:pcId/:groupIndex', async (req,res) => {
  const {pcId,groupIndex}=req.params;
  const [pcs,settings]=await Promise.all([dbGet('pcs'),dbGet('settings')]);
  const pc=(pcs||{})[pcId];
  if(!pc) return res.json({queue:[],started:runtime.started,settings:settings||DEFAULT_SETTINGS});
  const group=pc.groups[parseInt(groupIndex)];
  res.json({queue:group?group.queue:[],started:runtime.started,startedAt:runtime.startedAt,settings:settings||DEFAULT_SETTINGS});
});

app.get('/api/pcs-list', async (req,res) => {
  const pcs=await dbGet('pcs')||{};
  res.json(Object.entries(pcs).map(([id,pc])=>({id,label:pc.label,groupCount:pc.groups.length})));
});

// Status key now includes accountIndex: pc1-g0-a0
app.post('/api/status', (req,res) => {
  const {pcId,groupIndex,accountIndex,running,currentStore,listingsProcessed,storeIndex,totalStores,sessionEndTime,likesCount}=req.body;
  const key=`${pcId}-g${groupIndex}-a${accountIndex||0}`;
  runtime.status[key]={running,currentStore,listingsProcessed,storeIndex,totalStores,sessionEndTime,likesCount:likesCount||0,lastSeen:Date.now()};
  res.json({ok:true});
});

app.post('/api/complete', (req,res) => {
  const {pcId,groupIndex,accountIndex}=req.body;
  const key=`${pcId}-g${groupIndex}-a${accountIndex||0}`;
  if(runtime.status[key]) runtime.status[key].running=false;
  res.json({ok:true});
});

const PORT=process.env.PORT||3000;
initDB().then(()=>{ startScheduler(); app.listen(PORT,()=>console.log(`[Hivemind] Port ${PORT}`)); })
  .catch(err=>{ console.error('[Hivemind] DB failed:',err); process.exit(1); });
