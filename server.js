const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = 'clockworked_secret_salt_998124_!@#';
const DB_FILE = path.join(__dirname, 'db.json');

// ── Database ─────────────────────────────────────────────────────────────────
let db = { users: {} };
if (fs.existsSync(DB_FILE)) {
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!db.users) db.users = {};
  } catch (err) { console.error('DB load error, resetting:', err); }
}
function saveDb() {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8'); }
  catch (err) { console.error('DB save error:', err); }
}

// ── Map constants ─────────────────────────────────────────────────────────────
const CITY_WIDTH  = 3200;
const CITY_HEIGHT = 2400;

// Expanded City Districts
const NPCs = {
  forge:        { name: 'Forge Master',   x: 800,  y: 800,  r: 80 },
  merchant:     { name: 'Merchant',       x: 600,  y: 1200, r: 80 },
  pawn:         { name: 'Pawn Shop',      x: 1000, y: 1200, r: 80 },
  blacksmith:   { name: 'Blacksmith',     x: 1400, y: 1200, r: 80 },
  tinker:       { name: 'Amulet Tinker',  x: 600,  y: 1600, r: 80 },
  potions:      { name: 'Potion Vendor',  x: 1000, y: 1600, r: 80 },
  relics:       { name: 'Relic Dealer',   x: 1400, y: 1600, r: 80 },
  quests:       { name: 'Quest Board',    x: 1000, y: 800,  r: 80 },
  transmuter:   { name: 'Transmuter',     x: 1400, y: 800,  r: 80 }
};

const LOBBY_SQUARES = {
  A:     { name: 'Party Square A', x: 2100, y: 1600, r: 60 },
  B:     { name: 'Party Square B', x: 2250, y: 1600, r: 60 },
  C:     { name: 'Party Square C', x: 2400, y: 1600, r: 60 },
  quick: { name: 'Quick Run',      x: 2300, y: 1450, r: 60 }
};

// ── Quests System ─────────────────────────────────────────────────────────────
function generateQuests(level, floor) {
  return [
    { id: 'q1_' + Date.now(), type: 'kill', target: 20 + Math.floor(Math.random() * 10), progress: 0, rewardGold: 50 * level, rewardXp: 100 * level, done: false, desc: 'Slay Enemies in the Tower' },
    { id: 'q2_' + Date.now(), type: 'reach', target: Math.max(10, Math.floor(floor / 10) * 10 + 10), progress: floor, rewardGold: 150 * level, rewardXp: 300 * level, done: false, desc: 'Reach a new checkpoint floor' },
    { id: 'q3_' + Date.now(), type: 'gold', target: 200 * level, progress: 0, rewardGold: 0, rewardXp: 200 * level, rewardItem: true, done: false, desc: 'Earn Gold in the Tower' }
  ];
}

// Ensure all existing users in DB have quests initialized on startup
Object.keys(db.users).forEach(username => {
  const u = db.users[username];
  if (!u.quests) {
    u.quests = generateQuests(u.level || 1, u.highestFloor || 1);
    u.questDate = Date.now();
  }
});
saveDb();

// ── Loot tables ───────────────────────────────────────────────────────────────
const ITEM_NAMES = {
  weapon: {
    swordsman: ['Iron Blade','Steel Broadsword','Rune Greatsword','Clockwork Claymore','Aether Chronoblade'],
    archer:    ['Short Bow','Composite Bow','Clockwork Longbow','Stormstrike Recurve','Zephyr Chronobow'],
    mage:      ['Apprentice Staff','Focus Wand','Crystalline Staff','Clockwork Scepter','Cosmic Chronostaff'],
    healer:    ['Wooden Rod','Mend Wand','Aegis Staff','Clockwork Crook','Seraph Chronocrook']
  },
  head:      ['Leather Cap', 'Iron Helm', 'Clockwork Helm', 'Aether Visor', 'Chronos Crown'],
  armor:     ['Scrap Vest','Reinforced Tunic','Clockwork Mail','Aether Cuirass','Chronos Bulwark'],
  legs:      ['Leather Chaps', 'Iron Greaves', 'Clockwork Chausses', 'Aether Legguards', 'Chronos Greaves'],
  boots:     ['Leather Boots', 'Iron Sabatons', 'Clockwork Treads', 'Aether Stompers', 'Chronos Sabatons'],
  accessory: ['Copper Band','Glow Ring','Clockwork Cogwheel','Temporal Loop','Chronos Amulet']
};

function generateLoot(floor, itemClass) {
  const types = ['weapon','armor','head','legs','boots','accessory'];
  const type  = types[Math.floor(Math.random() * types.length)];
  const roll  = Math.random() * 100;
  let rarity = 'common', rarityMult = 1.0;
  if      (roll < Math.min(0.5  + floor * 0.15, 12)) { rarity = 'legendary'; rarityMult = 2.5; }
  else if (roll < Math.min(2.5  + floor * 0.3,  25)) { rarity = 'epic';      rarityMult = 1.8; }
  else if (roll < Math.min(8    + floor * 0.6,  45)) { rarity = 'rare';      rarityMult = 1.4; }
  else if (roll < Math.min(22   + floor * 1.0,  70)) { rarity = 'uncommon';  rarityMult = 1.15; }

  const tier = Math.floor((floor - 1) / 5) + 1; // Tier increases every 5 floors

  let name = '';
  if (type === 'weapon') {
    const list = ITEM_NAMES.weapon[itemClass] || ITEM_NAMES.weapon.swordsman;
    name = list[Math.min(list.length - 1, Math.floor((tier - 1) / 2))]; // Advance names slower
  } else {
    name = ITEM_NAMES[type][Math.min(ITEM_NAMES[type].length - 1, Math.floor((tier - 1) / 2))];
  }

  const baseVal = Math.round(tier * 5 * rarityMult);
  const stats = { atk: 0, def: 0, hp: 0, healing: 0 };
  if (type === 'weapon') {
    if (itemClass === 'healer') stats.healing = baseVal;
    else stats.atk = baseVal;
  } else if (['armor', 'head', 'legs', 'boots'].includes(type)) {
    stats.def = Math.round(baseVal * 0.4);
    stats.hp  = Math.round(baseVal * 2);
  } else {
    stats.atk = Math.round(baseVal * 0.2);
    stats.def = Math.round(baseVal * 0.1);
    stats.hp  = Math.round(baseVal * 1);
  }

  return {
    id:           'item_' + Math.random().toString(36).substr(2, 9),
    name:         `[T${tier}] ${rarity.toUpperCase()} ${name}`,
    type, rarity, level: tier, itemClass, stats,
    fuseCount: 0, durability: 100, maxDurability: 100
  };
}

function decayItem(user, player, type) {
  // Durability feature disabled for now
}

// ── Stat calculator ───────────────────────────────────────────────────────────
function getPlayerStats(user) {
  const base = {
    swordsman: { maxHp: 100, atk: 2,  def: 4, healing: 0, speedMult: 1.0 },
    archer:    { maxHp: 100, atk: 2,  def: 2, healing: 0, speedMult: 1.15 }, // Archer passive speed
    mage:      { maxHp: 100, atk: 2,  def: 1, healing: 0, speedMult: 1.0 },
    healer:    { maxHp: 100, atk: 1,  def: 2, healing: 3, speedMult: 1.0 }
  }[user.class] || { maxHp: 100, atk: 2, def: 2, healing: 0, speedMult: 1.0 };

  const lvl       = user.level || 1;
  const lvlScale  = 1.0 + (lvl - 1) * 0.08;
  const upgrades  = user.upgrades || { hp: 0, atk: 0, def: 0, healing: 0 };

  let hpBonus      = (upgrades.hp      || 0) * 15;
  let atkBonus     = (upgrades.atk     || 0) * 2;
  let defBonus     = (upgrades.def     || 0) * 1.5;
  let healingBonus = (upgrades.healing || 0) * 2;

  Object.values(user.equipped || {}).forEach(itemId => {
    if (!itemId) return;
    const item = (user.inventory || []).find(i => i.id === itemId);
    if (item && (item.durability === undefined || item.durability > 0)) {
      hpBonus      += item.stats.hp      || 0;
      atkBonus     += item.stats.atk     || 0;
      defBonus     += item.stats.def     || 0;
      healingBonus += item.stats.healing || 0;
    }
  });

  const maxHp = Math.round((base.maxHp + hpBonus) * lvlScale);
  return {
    maxHp,
    hp:      maxHp,
    atk:     Math.round((base.atk     + atkBonus)     * lvlScale),
    def:     Math.round((base.def     + defBonus)      * lvlScale),
    healing: Math.round((base.healing + healingBonus)  * lvlScale),
    speedMult: base.speedMult
  };
}

// ── Skills & Cooldowns ────────────────────────────────────────────────────────
const SKILL_COOLDOWNS = {
  slash:       12,
  taunt:       40,
  double_shot: 16,
  heal:        30,
  arcane_bolt: 10,   // Mage spell 1
  fireball:    24,   // Mage spell 2
  lightning:   36    // Mage spell 3
};

// ── Express setup ─────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/register', async (req, res) => {
  const { username, password, charClass } = req.body;
  if (!username || !password || !charClass) return res.status(400).json({ error: 'Missing fields' });

  const clean = username.trim().toLowerCase();
  if (db.users[clean]) return res.status(400).json({ error: 'Username already exists' });
  if (!['swordsman','archer','healer','mage'].includes(charClass)) return res.status(400).json({ error: 'Invalid class' });

  const hashed = await bcrypt.hash(password, 10);
  db.users[clean] = {
    username: clean, password: hashed, class: charClass,
    gold: 150, resourceGears: 0, level: 1, xp: 0, highestFloor: 1,
    inventory: [], equipped: { weapon: null, armor: null, accessory: null },
    upgrades: { hp: 0, atk: 0, def: 0, healing: 0 },
    quests: generateQuests(1, 1),
    questDate: Date.now()
  };
  saveDb();
  const token = jwt.sign({ username: clean }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ token, username: clean });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const clean = username.trim().toLowerCase();
  const user  = db.users[clean];
  if (!user || !(await bcrypt.compare(password, user.password))) return res.status(400).json({ error: 'Invalid credentials' });

  // Safety initialize quests
  if (!user.quests) {
    user.quests = generateQuests(user.level || 1, user.highestFloor || 1);
    user.questDate = Date.now();
    saveDb();
  }

  // Daily quest reset
  if (Date.now() - (user.questDate || 0) > 86400000) {
    user.quests = generateQuests(user.level || 1, user.highestFloor || 1);
    user.questDate = Date.now();
    saveDb();
  }

  const token = jwt.sign({ username: clean }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ token, username: clean });
});

// ── WebSocket server ──────────────────────────────────────────────────────────
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

const activePlayers = new Map();
const parties       = new Map();
const marketStands  = new Map();
const padLobbies = {}; // padId => { host, maxPlayers, floor, players: [ws] }

function pushLobbyUpdate(padId) {
  const lobby = padLobbies[padId];
  if (!lobby) return;
  const playerNames = lobby.players.map(p => p._username);
  lobby.players.forEach(pws => {
    pws.send(JSON.stringify({ type: 'party_lobby_update', partyId: padId, host: lobby.host, maxPlayers: lobby.maxPlayers, floor: lobby.floor, players: playerNames }));
  });
}

function sendTo(ws, obj) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
function broadcastToZone(party, obj, zone) {
  const msg = JSON.stringify(obj);
  party.members.forEach(ws => {
    const p = activePlayers.get(ws);
    if (p && p.zone === zone && ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}
function broadcastToCity(obj) {
  const msg = JSON.stringify(obj);
  activePlayers.forEach((p, ws) => { if (p.zone === 'city' && ws.readyState === WebSocket.OPEN) ws.send(msg); });
}
function broadcastToParty(party, obj) {
  const msg = JSON.stringify(obj);
  party.members.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
}

function pushPartyUpdate(party) {
  const memberData = party.members.map(ws => {
    const p = activePlayers.get(ws);
    return { username: p.username, class: p.class, hp: p.hp, maxHp: p.maxHp, mana: p.mana, maxMana: p.maxMana,
             level: p.level, x: p.x, y: p.y, dir: p.dir, zone: p.zone, action: p.action };
  });
  broadcastToParty(party, {
    type: 'party_update',
    party: { id: party.id, name: party.name, floor: party.floor, members: memberData, inCombat: party.combat.active, enemies: party.combat.enemies }
  });
}

function getFloorBiome(floor) {
  if (floor <= 9)  return 'grassland';
  if (floor <= 19) return 'swamp';
  if (floor <= 29) return 'stone';
  if (floor <= 39) return 'winter';
  if (floor <= 49) return 'infernal';
  return 'void';
}

const BIOME_ENEMIES = {
  grassland: [
    { cls: 'zombie',  nameBase: 'Rotting Zombie',    hpMult: 0.8, atkMult: 0.7, speed: 1.4 },
    { cls: 'zombie',  nameBase: 'Shambling Dead',     hpMult: 0.9, atkMult: 0.8, speed: 1.2 },
    { cls: 'goblin',  nameBase: 'Goblin Scout',       hpMult: 0.6, atkMult: 1.0, speed: 2.8 },
    { cls: 'goblin',  nameBase: 'Goblin Brute',       hpMult: 1.0, atkMult: 1.2, speed: 2.2 },
  ],
  swamp: [
    { cls: 'orc',     nameBase: 'Swamp Orc',          hpMult: 1.2, atkMult: 1.1, speed: 2.0 },
    { cls: 'ogre',    nameBase: 'Bog Ogre',            hpMult: 2.0, atkMult: 1.4, speed: 1.6 },
    { cls: 'goblin',  nameBase: 'Marsh Goblin',        hpMult: 0.7, atkMult: 1.1, speed: 3.0 },
  ],
  stone: [
    { cls: 'skeleton_sword',   nameBase: 'Bone Knight',    hpMult: 1.0, atkMult: 1.2, speed: 2.0 },
    { cls: 'skeleton_archer',  nameBase: 'Bone Archer',    hpMult: 0.8, atkMult: 1.3, speed: 1.8 },
    { cls: 'stone_golem',      nameBase: 'Stone Golem',    hpMult: 2.5, atkMult: 1.0, speed: 1.2 },
  ],
  winter: [
    { cls: 'frost_wolf',  nameBase: 'Frost Wolf',      hpMult: 1.1, atkMult: 1.4, speed: 3.2 },
    { cls: 'ice_golem',   nameBase: 'Ice Golem',       hpMult: 2.2, atkMult: 1.2, speed: 1.4 },
    { cls: 'snow_witch',  nameBase: 'Snow Witch',      hpMult: 0.9, atkMult: 1.6, speed: 2.0 },
  ],
  infernal: [
    { cls: 'hellhound',   nameBase: 'Hellhound',       hpMult: 1.3, atkMult: 1.6, speed: 3.4 },
    { cls: 'lava_golem',  nameBase: 'Lava Golem',      hpMult: 3.0, atkMult: 1.3, speed: 1.1 },
  ],
  void: [
    { cls: 'void_shade',     nameBase: 'Void Shade',      hpMult: 1.4, atkMult: 1.8, speed: 3.0 },
    { cls: 'rift_colossus',  nameBase: 'Rift Colossus',   hpMult: 4.0, atkMult: 1.5, speed: 1.0 },
  ]
};

function startCombat(party, startingFloor) {
  if (party.combat.active) return;
  party.combat.active = true;
  party.floor = startingFloor;
  party.combat.enemies = [];
  party.combat.aoeWarnings = [];

  const instanceZone = `tower_instance_${party.id}`;

  party.members.forEach(ws => {
    const p = activePlayers.get(ws);
    if (p) {
      p.hp = p.maxHp; p.mana = p.maxMana; p.x = 400; p.y = 300; p.zone = instanceZone;
      const u = db.users[p.username];
      if (u) u.quests.forEach(q => { if (q.type === 'reach' && startingFloor > q.progress) q.progress = startingFloor; });
    }
  });

  const numPlayers = party.members.length;
  const biome = getFloorBiome(startingFloor);
  const pool  = BIOME_ENEMIES[biome];
  const baseScale = 1.0 + (startingFloor - 1) * 0.12 + (numPlayers - 1) * 0.35;
  const count = Math.min(10, Math.round(3 + startingFloor * 0.8 + numPlayers * 1.2));

  // Spawn regular enemies
  for (let i = 0; i < count; i++) {
    const tmpl = pool[Math.floor(Math.random() * pool.length)];
    const hp   = Math.round((35 + Math.random() * 20) * baseScale * tmpl.hpMult);
    let rx = Math.random() > 0.5 ? 60 : 740;
    let ry = 80 + Math.random() * 440;
    if (Math.random() > 0.5) { rx = 80 + Math.random() * 640; ry = Math.random() > 0.5 ? 60 : 540; }
    party.combat.enemies.push({
      id: `enemy_${i}_${Math.random().toString(36).substr(2,5)}`,
      name: tmpl.nameBase,
      enemyClass: tmpl.cls,
      hp, maxHp: hp,
      atk: Math.round((5 + Math.random() * 4) * baseScale * tmpl.atkMult),
      def: Math.round((1 + Math.random() * 3) * baseScale),
      x: rx, y: ry,
      speed: tmpl.speed + startingFloor * 0.03,
      cooldown: Math.floor(Math.random() * 20),
      action: 'walk', dir: 'down', walkTick: 0,
      isBoss: false,
      windupActive: false, windupTicks: 0,
      heavyTimer: 15 + Math.floor(Math.random() * 20)
    });
  }

  // Miniboss: Cursed Knight on milestone floors (25, 35, 45…)
  if (startingFloor >= 25 && startingFloor % 5 === 0) {
    const bossHp = Math.round(180 * baseScale);
    party.combat.enemies.push({
      id: `boss_${Math.random().toString(36).substr(2,6)}`,
      name: 'Cursed Knight',
      enemyClass: 'cursed_knight',
      hp: bossHp, maxHp: bossHp,
      atk: Math.round(14 * baseScale), def: Math.round(5 * baseScale),
      x: 400, y: 80,
      speed: 1.8 + startingFloor * 0.02,
      cooldown: 40, action: 'walk', dir: 'down', walkTick: 0,
      isBoss: true,
      windupActive: false, windupTicks: 0,
      heavyTimer: 50, aoeCooldown: 100
    });
  }

  const biomeLabel = biome.charAt(0).toUpperCase() + biome.slice(1);
  broadcastToZone(party, { type: 'combat_start', enemies: party.combat.enemies, biome, log: `Floor ${startingFloor} — ${biomeLabel} begins!` }, instanceZone);
  pushPartyUpdate(party);
}


// ── Physics Tick (20 Hz) ──────────────────────────────────────────────────────
setInterval(() => {
  parties.forEach(party => {
    if (!party.combat.active) return;
    const zone = `tower_instance_${party.id}`;

    const livingMembers = party.members.filter(ws => { const p = activePlayers.get(ws); return p && p.hp > 0; });
    if (livingMembers.length === 0) {
      party.combat.active = false; party.combat.enemies = [];
      broadcastToZone(party, { type: 'combat_end', result: 'defeat', log: 'Defeat! Returning to City.' }, zone);
      party.members.forEach(ws => { const p = activePlayers.get(ws); if (p) { p.hp = p.maxHp; p.x = 400; p.y = 1800; p.zone = 'city'; } });
      party.floor = 1;
      pushPartyUpdate(party);
      return;
    }

    const aliveEnemies = party.combat.enemies.filter(e => e.hp > 0);
    if (aliveEnemies.length === 0) {
      party.combat.active = false;
      const goldReward = Math.round(party.floor * 12 * (1 + Math.random() * 0.4));
      const gearReward = Math.round(party.floor * 1.5);
      const xpReward   = Math.round(party.floor * 25);

      party.members.forEach(ws => {
        const p = activePlayers.get(ws);
        if (!p) return;
        const u = db.users[p.username];
        u.gold += goldReward; u.resourceGears = (u.resourceGears || 0) + gearReward; u.xp = (u.xp || 0) + xpReward;
        
        u.quests.forEach(q => {
          if (q.type === 'kill') q.progress += party.combat.enemies.length;
          if (q.type === 'gold') q.progress += goldReward;
        });

        if (u.xp >= (u.level || 1) * 150) { u.xp -= u.level * 150; u.level = (u.level || 1) + 1; }
        if (party.floor > u.highestFloor) u.highestFloor = party.floor;

        p.gold = u.gold; p.level = u.level; p.resourceGears = u.resourceGears;
        p.hp = Math.min(p.maxHp, p.hp + Math.round(p.maxHp * 0.25));

        let loot = null;
        let potionDrops = { hp: 0, mp: 0 };
        if (Math.random() < 0.45 + party.floor * 0.01) { loot = generateLoot(party.floor, p.class); u.inventory.push(loot); }
        // 35% chance to drop 1-2 potions
        if (Math.random() < 0.35) {
          if (p.class === 'mage' && Math.random() < 0.5) { potionDrops.mp = Math.floor(Math.random() * 2) + 1; }
          else { potionDrops.hp = Math.floor(Math.random() * 2) + 1; }
        }

        Object.assign(p, getPlayerStats(u));
        sendTo(ws, { type: 'combat_rewards', gold: goldReward, xp: xpReward, gears: gearReward, loot, potionDrops, player: { gold: p.gold, resourceGears: p.resourceGears, level: p.level, xp: u.xp, inventory: u.inventory, quests: u.quests } });
      });
      saveDb();
      broadcastToZone(party, { type: 'combat_end', result: 'victory', log: `Floor ${party.floor} cleared!` }, zone);
      party.floor += 1;
      pushPartyUpdate(party);
      
      // Auto-start next floor after 3 seconds
      setTimeout(() => {
        if (parties.has(party.id) && !party.combat.active) {
          startCombat(party, party.floor);
        }
      }, 3000);
      return;
    }

    // Passive regeneration & Mana regen
    party.members.forEach(ws => {
      const p = activePlayers.get(ws);
      if (p && p.hp > 0 && p.zone === zone) {
        if (p.class === 'healer') p.hp = Math.min(p.maxHp, p.hp + 0.15); // Stronger passive regen
        else p.hp = Math.min(p.maxHp, p.hp + 0.05); // Minor passive regen

        if (p.class === 'mage') p.mana = Math.min(p.maxMana, p.mana + 0.8); // 16 mana per sec
      }
    });

    // Enemy AI — chase closest alive player; taunt overrides; heavy attack / parry window
    aliveEnemies.forEach(enemy => {
      let target = null, minDist = Infinity;
      let taunter = null;
      party.members.forEach(ws => {
        const p = activePlayers.get(ws);
        if (p && p.hp > 0 && p.zone === zone) {
          const d = Math.hypot(p.x - enemy.x, p.y - enemy.y);
          if (p.tauntTicks > 0) taunter = p;
          if (d < minDist) { minDist = d; target = p; }
        }
      });
      if (taunter) target = taunter;

      const tx = target ? target.x : 400, ty = target ? target.y : 300;
      const dist = Math.hypot(tx - enemy.x, ty - enemy.y);

      // If winding up — enemy stands still and counts down
      if (enemy.windupActive) {
        enemy.windupTicks--;
        enemy.action = 'windup';
        if (enemy.windupTicks <= 0) {
          // Execute heavy attack
          enemy.windupActive = false;
          if (target && Math.hypot(tx - enemy.x, ty - enemy.y) < 80) {
            const heavyDmg = Math.max(1, Math.round(enemy.atk * 1.8 - target.def * 0.3));
            target.hp = Math.max(0, target.hp - heavyDmg);
            const u = db.users[target.username];
            if (u) { decayItem(u, target, 'armor'); saveDb(); }
            broadcastToZone(party, { type: 'combat_hit', source: enemy.name, target: target.username, damage: heavyDmg, isHeal: false, isHeavy: true, log: `${enemy.name} HEAVY STRIKE hits ${target.username} for ${heavyDmg}!` }, zone);
          }
          enemy.cooldown = 30;
          enemy.heavyTimer = 40 + Math.floor(Math.random() * 30);
        }
        if (enemy.cooldown > 0) enemy.cooldown--;
        return; // skip normal movement while winding up
      }

      // Normal movement
      if (dist > 32) {
        const dx = (tx - enemy.x) / dist, dy = (ty - enemy.y) / dist;
        enemy.x += dx * enemy.speed; enemy.y += dy * enemy.speed;
        enemy.action = 'walk'; enemy.walkTick = (enemy.walkTick || 0) + 1;
        enemy.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
      } else {
        enemy.action = 'attack';
      }

      // Normal attack
      if (target && dist < 50 && enemy.cooldown <= 0) {
        // Check if it's time for a heavy attack
        enemy.heavyTimer = (enemy.heavyTimer || 0) - 1;
        if (enemy.heavyTimer <= 0) {
          // Begin windup
          enemy.windupActive = true;
          enemy.windupTicks = 40;
          broadcastToZone(party, { type: 'enemy_windup', id: enemy.id, x: enemy.x, y: enemy.y, isBoss: enemy.isBoss || false }, zone);
          return;
        }

        // Normal attack
        enemy.cooldown = 28;
        let parried = false;
        if (target.class === 'swordsman' && Math.random() < 0.05) {
          parried = true;
          broadcastToZone(party, { type: 'combat_hit', source: enemy.name, target: target.username, damage: 0, isHeal: false, log: `${target.username} auto-parried ${enemy.name}!` }, zone);
        }
        if (!parried) {
          const netDmg = Math.max(1, Math.round(enemy.atk - target.def * 0.5));
          target.hp = Math.max(0, target.hp - netDmg);
          const u = db.users[target.username];
          if (u) { decayItem(u, target, 'armor'); saveDb(); }
          broadcastToZone(party, { type: 'combat_hit', source: enemy.name, target: target.username, damage: netDmg, isHeal: false, log: `${enemy.name} hits ${target.username} for ${netDmg} dmg!` }, zone);
        }
      }
      if (enemy.cooldown > 0) enemy.cooldown--;

      // Cursed Knight AoE telegraph
      if (enemy.isBoss && enemy.enemyClass === 'cursed_knight') {
        enemy.aoeCooldown = (enemy.aoeCooldown || 100) - 1;
        if (enemy.aoeCooldown <= 0) {
          enemy.aoeCooldown = 120;
          broadcastToZone(party, { type: 'aoe_warning', id: enemy.id, x: enemy.x, y: enemy.y, r: 90, delay: 40 }, zone);
          // Delayed AoE execution (40 ticks = 2 seconds)
          setTimeout(() => {
            if (!party.combat.active) return;
            const cx = enemy.x, cy = enemy.y;
            party.members.forEach(mws => {
              const mp = activePlayers.get(mws);
              if (mp && mp.hp > 0 && mp.zone === zone) {
                if (Math.hypot(mp.x - cx, mp.y - cy) < 90) {
                  const aoeDmg = Math.max(1, Math.round(enemy.atk * 1.2));
                  mp.hp = Math.max(0, mp.hp - aoeDmg);
                  broadcastToZone(party, { type: 'combat_hit', source: enemy.name, target: mp.username, damage: aoeDmg, isHeal: false, isAoe: true, log: `${enemy.name} AOE crushes ${mp.username} for ${aoeDmg}!` }, zone);
                }
              }
            });
          }, 2000);
        }
      }
    });

    const snap = party.members.map(ws => {
      const p = activePlayers.get(ws);
      if (p.actionTicks > 0) p.actionTicks--; else p.action = 'none';
      if (p.tauntTicks > 0) p.tauntTicks--;
      return { username: p.username, hp: p.hp, maxHp: p.maxHp, mana: p.mana, maxMana: p.maxMana, x: p.x, y: p.y, dir: p.dir, class: p.class, action: p.action };
    });
    const esnap = aliveEnemies.map(e => ({
      id: e.id, name: e.name, hp: e.hp, maxHp: e.maxHp,
      x: e.x, y: e.y, action: e.action, dir: e.dir || 'down', walkTick: e.walkTick || 0,
      enemyClass: e.enemyClass || 'zombie', isBoss: e.isBoss || false, windingUp: e.windupActive || false
    }));
    broadcastToParty(party, { type: 'physics_tick', enemies: esnap, members: snap });
  });
}, 50);


// ── City Tick (12.5 Hz) ───────────────────────────────────────────────────────
setInterval(() => {
  const zones = {};
  activePlayers.forEach(p => {
    if (!p.zone.startsWith('tower_instance')) {
      if (p.actionTicks > 0) p.actionTicks--; else p.action = 'none';
      if (!zones[p.zone]) zones[p.zone] = [];
      zones[p.zone].push({ username: p.username, class: p.class, x: p.x, y: p.y, dir: p.dir, level: p.level, action: p.action });
    }
  });
  const stands = Array.from(marketStands.values()).map(s => ({ owner: s.owner, x: s.x, y: s.y, level: s.level }));
  
  activePlayers.forEach((p, ws) => {
    if (!p.zone.startsWith('tower_instance') && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'city_tick', players: zones[p.zone] || [], stands: p.zone === 'city' ? stands : [] }));
    }
  });
}, 80);

// ── WebSocket ─────────────────────────────────────────────────────────────────
wss.on('connection', ws => {
  let player = null;
  let currentParty = null;
  const skillCooldowns = {};

  ws.on('message', async raw => {
    try {
      const data = JSON.parse(raw);

      if (data.type === 'auth') {
        let decoded;
        try { decoded = jwt.verify(data.token, JWT_SECRET); } catch { ws.close(); return; }
        const u = db.users[decoded.username];
        if (!u) { ws.close(); return; }

        const stats = getPlayerStats(u);
        player = {
          username: u.username, class: u.class,
          ...stats,
          mana: 100, maxMana: 100,
          gold: u.gold, resourceGears: u.resourceGears || 0, level: u.level || 1,
          tauntTicks: 0, action: 'none', actionTicks: 0,
          x: 400, y: 1800, dir: 'down', zone: 'city'
        };
        ws._username = u.username;
        activePlayers.set(ws, player);
        sendTo(ws, { type: 'auth_success', player, xp: u.xp || 0, inventory: u.inventory, equipped: u.equipped, upgrades: u.upgrades, highestFloor: u.highestFloor, quests: u.quests });
        return;
      }

      if (!player) return;
      const u = db.users[player.username];

      switch (data.type) {
        case 'change_zone':
          player.zone = data.targetZone;
          player.x = data.x;
          player.y = data.y;
          break;

        case 'move':
          if (player.zone === 'city') {
            player.x = Math.max(10, Math.min(CITY_WIDTH  - 10, data.x));
            player.y = Math.max(10, Math.min(CITY_HEIGHT - 10, data.y));
          } else if (player.zone.startsWith('interior_')) {
            player.x = Math.max(40, Math.min(760, data.x));
            player.y = Math.max(80, Math.min(555, data.y));
          } else {
            player.x = Math.max(20, Math.min(780, data.x));
            player.y = Math.max(20, Math.min(580, data.y));
          }
          player.dir = data.dir || 'down';
          if (data.moving) player.action = 'walk';
          break;

        case 'join_party_pad':
          const lobbyId = data.padId;
          if (lobbyId === 'quick') {
             // Solo Quick Play logic
             if (currentParty) {
               currentParty.members = currentParty.members.filter(m => m !== ws);
               if (currentParty.members.length === 0) parties.delete(currentParty.id);
             }
             if (!parties.has('quick')) parties.set('quick', { id: 'quick', name: `${player.username}'s Solo`, members: [], floor: 1, combat: { active: false, enemies: [] } });
             currentParty = parties.get('quick');
             currentParty.members.push(ws);
             sendTo(ws, { type: 'join_success', partyId: 'quick' });
             break;
          }

          if (!padLobbies[lobbyId]) {
            padLobbies[lobbyId] = { host: player.username, maxPlayers: 4, floor: 1, players: [] };
          }
          const lobby = padLobbies[lobbyId];
          if (lobby.players.length >= lobby.maxPlayers && !lobby.players.includes(ws)) {
            sendTo(ws, { type: 'error', message: 'Party lobby is full!' });
            return;
          }
          if (!lobby.players.includes(ws)) {
            ws._lobbyId = lobbyId;
            lobby.players.push(ws);
          }
          sendTo(ws, { type: 'join_success', partyId: lobbyId });
          pushLobbyUpdate(lobbyId);
          break;

        case 'update_party_settings':
          const lid = ws._lobbyId;
          if (lid && padLobbies[lid] && padLobbies[lid].host === player.username) {
            if (data.maxPlayers) padLobbies[lid].maxPlayers = data.maxPlayers;
            if (data.floor) padLobbies[lid].floor = data.floor;
            pushLobbyUpdate(lid);
          }
          break;

        case 'leave_party':
          const leaveId = ws._lobbyId;
          if (leaveId && padLobbies[leaveId]) {
            padLobbies[leaveId].players = padLobbies[leaveId].players.filter(p => p !== ws);
            ws._lobbyId = null;
            if (padLobbies[leaveId].players.length === 0) {
              delete padLobbies[leaveId];
            } else {
              if (padLobbies[leaveId].host === player.username) {
                padLobbies[leaveId].host = padLobbies[leaveId].players[0]._username;
              }
              pushLobbyUpdate(leaveId);
            }
          }
          break;

        case 'start_climb':
          const floor = Math.max(1, parseInt(data.floor) || 1);
          // Checkpoint Validation (Multiples of 10)
          if (floor !== 1 && floor % 10 !== 0) { sendTo(ws, { type: 'error', message: 'Can only start on checkpoint floors (multiples of 10).' }); return; }
          if (floor > (u.highestFloor || 1)) { sendTo(ws, { type: 'error', message: 'You have not cleared this checkpoint yet!' }); return; }

          if (ws._lobbyId && ws._lobbyId !== 'quick') {
            const l = padLobbies[ws._lobbyId];
            if (!l) return;
            if (l.host !== player.username) { sendTo(ws, { type: 'error', message: 'Only the host can start the party!' }); return; }
            
            // Create actual party
            const newPid = 'party_' + Date.now();
            parties.set(newPid, { id: newPid, name: `${l.host}'s Party`, members: [...l.players], floor: l.floor, combat: { active: false, enemies: [] } });
            const p = parties.get(newPid);
            
            l.players.forEach(pws => {
              pws._lobbyId = null;
              activePlayers.get(pws).zone = 'interior_tower'; // will be pushed to tower map
            });
            delete padLobbies[ws._lobbyId];
            
            currentParty = p;
          } else {
             if (!currentParty || currentParty.combat.active) return;
             currentParty.floor = floor;
          }
          startCombat(currentParty, floor);
          break;

        case 'attack': {
          // Left-click basic attack — every class
          if (!currentParty || !currentParty.combat.active || player.hp <= 0) break;
          const atkZone = `tower_instance_${currentParty.id}`;
          const atkNow = Date.now();
          const atkCd = player.class === 'goblin' ? 400 : (player.class === 'mage' ? 800 : 500);
          if (atkNow - (skillCooldowns['_attack'] || 0) < atkCd) break;
          skillCooldowns['_attack'] = atkNow;

          const atkAlive = currentParty.combat.enemies.filter(e => e.hp > 0);
          const isRanged = player.class === 'archer' || player.class === 'mage';
          const atkRange = isRanged ? 300 : 120;
          const atkTarget = atkAlive.reduce((c, e) => {
            const d = Math.hypot(e.x - player.x, e.y - player.y);
            return d < atkRange && (!c || d < Math.hypot(c.x - player.x, c.y - player.y)) ? e : c;
          }, null);

          if (atkTarget) {
            player.action = player.class === 'mage' ? 'magic' : (player.class === 'archer' ? 'shoot' : 'swing');
            player.actionTicks = 10;
            const dmg = calcDmg(player, player.class === 'mage' ? 'magic' : 'physical');
            const reduced = Math.max(1, dmg - Math.round(atkTarget.def * 0.3));
            atkTarget.hp = Math.max(0, atkTarget.hp - reduced);
            decayItem(u, player, 'weapon');
            broadcastToZone(currentParty, { type: 'combat_hit', source: player.username, target: atkTarget.id, damage: reduced, isHeal: false, log: `${player.username} hits ${atkTarget.name} for ${reduced}!` }, atkZone);
          }
          saveDb();
          break;
        }

        case 'parry_attempt': {
          // E-key parry — counter a winding-up enemy
          if (!currentParty || !currentParty.combat.active || player.hp <= 0) break;
          const parryZone = `tower_instance_${currentParty.id}`;
          const windingEnemy = currentParty.combat.enemies.find(e =>
            e.hp > 0 && e.windupActive && e.windupTicks > 5 &&
            Math.hypot(e.x - player.x, e.y - player.y) < 150
          );
          if (windingEnemy) {
            windingEnemy.windupActive = false;
            windingEnemy.windupTicks = 0;
            windingEnemy.heavyTimer = 50 + Math.floor(Math.random() * 30);
            const counterDmg = Math.max(2, Math.round(player.atk * 1.5));
            windingEnemy.hp = Math.max(0, windingEnemy.hp - counterDmg);
            player.action = 'swing'; player.actionTicks = 12;
            broadcastToZone(currentParty, { type: 'parry_success', parrier: player.username, enemyId: windingEnemy.id, counterDmg }, parryZone);
            broadcastToZone(currentParty, { type: 'combat_hit', source: player.username, target: windingEnemy.id, damage: counterDmg, isHeal: false, log: `${player.username} PARRIED and countered ${windingEnemy.name} for ${counterDmg}!` }, parryZone);
          }
          break;
        }

        case 'use_skill':

          if (!currentParty || !currentParty.combat.active || player.hp <= 0) return;
          const { skillId } = data;
          const zone = `tower_instance_${currentParty.id}`;

          const now = Date.now();
          const cdTicks = SKILL_COOLDOWNS[skillId] || 20;
          if (now - (skillCooldowns[skillId] || 0) < cdTicks * 50) return; // Silent reject if early
          
          const alive = currentParty.combat.enemies.filter(e => e.hp > 0);

          if (player.class === 'mage') {
            const spellCosts = { arcane_bolt: 10, fireball: 25, lightning: 35 };
            if (player.mana < spellCosts[skillId]) { sendTo(ws, { type: 'error', message: 'Not enough Mana!' }); return; }
            player.mana -= spellCosts[skillId];
            player.action = 'magic'; player.actionTicks = 10;
            skillCooldowns[skillId] = now;
            decayItem(u, player, 'weapon');

            if (skillId === 'arcane_bolt') {
              const target = alive.reduce((c, e) => { const d = Math.hypot(e.x - player.x, e.y - player.y); return d < 250 && (!c || d < Math.hypot(c.x - player.x, c.y - player.y)) ? e : c; }, null);
              if (target) {
                const dmg = calcDmg(player, 'magic', 1.0, true, Math.random() * 1 + 2); // 2-3 base
                target.hp = Math.max(0, target.hp - dmg);
                broadcastToZone(currentParty, { type: 'combat_hit', source: player.username, target: target.id, damage: dmg, isHeal: false, log: `${player.username} zaps ${target.name} for ${dmg}!` }, zone);
              }
            } else if (skillId === 'fireball') {
              const target = alive.reduce((c, e) => { const d = Math.hypot(e.x - player.x, e.y - player.y); return d < 220 && (!c || d < Math.hypot(c.x - player.x, c.y - player.y)) ? e : c; }, null);
              if (target) {
                const dmg = calcDmg(player, 'magic', 1.3, true, Math.random() * 1 + 3); // 3-4 base
                alive.forEach(e => { const splash = Math.hypot(e.x - target.x, e.y - target.y); if (splash < 80) e.hp = Math.max(0, e.hp - dmg); });
                broadcastToZone(currentParty, { type: 'combat_hit', source: player.username, target: target.id, damage: dmg, isHeal: false, log: `${player.username}'s Fireball blasts for ${dmg}!` }, zone);
              }
            } else if (skillId === 'lightning') {
              const dmg = calcDmg(player, 'magic', 1.1, true, Math.random() * 3 + 2); // 2-5 base
              alive.forEach(e => { e.hp = Math.max(0, e.hp - dmg); });
              broadcastToZone(currentParty, { type: 'combat_hit', source: player.username, target: 'all', damage: dmg, isHeal: false, log: `${player.username} calls Lightning hitting all for ${dmg}!` }, zone);
            }
          } 
          else if (player.class === 'swordsman') {
            skillCooldowns[skillId] = now;
            player.action = 'swing'; player.actionTicks = 10;
            if (skillId === 'slash') {
              const target = alive.reduce((c, e) => { const d = Math.hypot(e.x - player.x, e.y - player.y); return d < 75 && (!c || d < Math.hypot(c.x - player.x, c.y - player.y)) ? e : c; }, null);
              if (target) {
                const dmg = Math.max(1, calcDmg(player, 'physical') - Math.round(target.def * 0.3));
                target.hp = Math.max(0, target.hp - dmg);
                decayItem(u, player, 'weapon');
                broadcastToZone(currentParty, { type: 'combat_hit', source: player.username, target: target.id, damage: dmg, isHeal: false, log: `${player.username} slashes ${target.name} for ${dmg}!` }, zone);
              }
            } else if (skillId === 'taunt') {
              player.tauntTicks = 20;
              broadcastToZone(currentParty, { type: 'combat_hit', source: player.username, target: null, damage: 0, isHeal: false, log: `${player.username} Taunts the enemies!` }, zone);
            }
          }
          else if (player.class === 'archer') {
            skillCooldowns[skillId] = now;
            player.action = 'shoot'; player.actionTicks = 10;
            if (skillId === 'double_shot') {
              const target = alive.reduce((c, e) => { const d = Math.hypot(e.x - player.x, e.y - player.y); return d < 280 && (!c || d < Math.hypot(c.x - player.x, c.y - player.y)) ? e : c; }, null);
              if (target) {
                const dmg = Math.max(1, calcDmg(player, 'physical', 1.0) - Math.round(target.def * 0.2));
                target.hp = Math.max(0, target.hp - dmg);
                decayItem(u, player, 'weapon');
                broadcastToZone(currentParty, { type: 'combat_hit', source: player.username, target: target.id, damage: dmg, isHeal: false, log: `${player.username} shoots ${target.name} for ${dmg}!` }, zone);
              }
            }
          }
          else if (player.class === 'healer') {
            skillCooldowns[skillId] = now;
            player.action = 'heal'; player.actionTicks = 10;
            if (skillId === 'heal') {
              let lowestAlly = null, lowestRatio = 1.1;
              currentParty.members.forEach(m => {
                const p = activePlayers.get(m);
                if (p && p.hp > 0 && p.zone === zone) { const r = p.hp / p.maxHp; if (r < lowestRatio) { lowestRatio = r; lowestAlly = p; } }
              });
              if (lowestAlly) {
                const healVal = calcDmg(player, 'magic', 1.0); // 2-4 base
                lowestAlly.hp = Math.min(lowestAlly.maxHp, lowestAlly.hp + healVal);
                decayItem(u, player, 'weapon');
                broadcastToZone(currentParty, { type: 'combat_hit', source: player.username, target: lowestAlly.username, damage: healVal, isHeal: true, log: `${player.username} mends ${lowestAlly.username} for ${healVal} HP!` }, zone);
              }
            }
          }
          saveDb();
          break;

        case 'equip_item':
        case 'unequip_item':
          if (data.type === 'equip_item') {
            const item = u.inventory.find(i => i.id === data.itemId);
            if (item) u.equipped[item.type] = item.id;
          } else {
            if (data.slot && u.equipped[data.slot]) u.equipped[data.slot] = null;
          }
          saveDb();
          Object.assign(player, getPlayerStats(u));
          sendTo(ws, { type: 'stats_update', player, equipped: u.equipped, inventory: u.inventory });
          if (currentParty) pushPartyUpdate(currentParty);
          break;

        case 'use_potion':
          if (!currentParty || player.hp <= 0) return;
          const zonePot = `tower_instance_${currentParty.id}`;
          if (data.potionType === 'hp') {
            const healVal = Math.round(player.maxHp * 0.4); // heals 40%
            player.hp = Math.min(player.maxHp, player.hp + healVal);
            broadcastToZone(currentParty, { type: 'combat_hit', source: player.username, target: player.username, damage: healVal, isHeal: true, log: `${player.username} uses HP Potion (+${healVal})` }, zonePot);
          } else if (data.potionType === 'mp' && player.class === 'mage') {
            player.mana = Math.min(player.maxMana, player.mana + 50);
          }
          sendTo(ws, { type: 'auth_success', player, xp: u.xp, inventory: u.inventory, equipped: u.equipped, upgrades: u.upgrades, highestFloor: u.highestFloor, quests: u.quests });
          break;

        // ── Pawn Shop ──
        case 'pawn_item':
          const idx = u.inventory.findIndex(i => i.id === data.itemId);
          if (idx === -1) return;
          if (Object.values(u.equipped).includes(data.itemId)) { sendTo(ws, { type: 'error', message: 'Unequip first!' }); return; }
          const item = u.inventory[idx];
          const val = Math.round(item.level * 4 * (item.durability ? item.durability/100 : 1));
          u.gold += val;
          u.inventory.splice(idx, 1);
          saveDb();
          player.gold = u.gold;
          sendTo(ws, { type: 'stats_update', player, inventory: u.inventory, equipped: u.equipped });
          sendTo(ws, { type: 'notification', message: `Sold ${item.name} for ${val}G` });
          break;

        // ── Quests ──
        case 'claim_quest':
          const qIdx = u.quests.findIndex(q => q.id === data.questId);
          if (qIdx === -1) return;
          const q = u.quests[qIdx];
          if (q.progress >= q.target && !q.done) {
            q.done = true;
            u.gold += q.rewardGold; u.xp += q.rewardXp;
            player.gold = u.gold;
            if (q.rewardItem) {
              const l = generateLoot(u.level, u.class);
              u.inventory.push(l);
              sendTo(ws, { type: 'notification', message: `Quest Done! +${q.rewardGold}G, +${q.rewardXp}XP, Gained ${l.name}!` });
            } else {
              sendTo(ws, { type: 'notification', message: `Quest Done! +${q.rewardGold}G, +${q.rewardXp}XP!` });
            }
            saveDb();
            sendTo(ws, { type: 'auth_success', player, xp: u.xp, quests: u.quests, inventory: u.inventory, equipped: u.equipped, upgrades: u.upgrades, highestFloor: u.highestFloor });
          }
          break;

        // ── Buying from standard NPC vendors ──
        case 'buy_merchant_item':
        case 'buy_blacksmith_item':
        case 'buy_potions_item':
        case 'buy_relics_item':
          let cost = 25;
          let boughtItem = null;
          if (data.type === 'buy_merchant_item') {
            if (u.gold < cost) { sendTo(ws, { type: 'error', message: 'Insufficient gold!' }); return; }
            u.gold -= cost; boughtItem = generateLoot(u.level, u.class);
            if (data.itemType) boughtItem.type = data.itemType;
          } else if (data.type === 'buy_blacksmith_item') {
            cost = u.level * 10;
            if (u.gold < cost) { sendTo(ws, { type: 'error', message: 'Insufficient gold!' }); return; }
            u.gold -= cost; boughtItem = generateLoot(u.level, u.class); boughtItem.type = 'weapon'; boughtItem.rarity = 'uncommon';
          } else if (data.type === 'buy_relics_item') {
            cost = u.level * 25;
            if (u.highestFloor < 20) { sendTo(ws, { type: 'error', message: 'You must reach floor 20 first!' }); return; }
            if (u.gold < cost) { sendTo(ws, { type: 'error', message: 'Insufficient gold!' }); return; }
            u.gold -= cost; boughtItem = generateLoot(u.level + 2, u.class); boughtItem.type = 'accessory'; boughtItem.rarity = 'rare';
          }
          if (boughtItem) {
            u.inventory.push(boughtItem);
            saveDb(); player.gold = u.gold;
            sendTo(ws, { type: 'stats_update', player, inventory: u.inventory, equipped: u.equipped });
            sendTo(ws, { type: 'notification', message: `Bought ${boughtItem.name}!` });
          }
          break;

        case 'upgrade_stat':
          const stat = data.stat; if (!['hp','atk','def','healing'].includes(stat)) return;
          const lvl = u.upgrades[stat] || 0; const upCost = (lvl + 1) * 35;
          if (u.gold < upCost) { sendTo(ws, { type: 'error', message: 'Insufficient gold!' }); return; }
          u.gold -= upCost; u.upgrades[stat] = lvl + 1; saveDb();
          Object.assign(player, getPlayerStats(u)); player.gold = u.gold;
          sendTo(ws, { type: 'upgrade_success', player, upgrades: u.upgrades });
          break;

        case 'repair_item':
          const rit = u.inventory.find(i => i.id === data.itemId); if (!rit) return;
          const rdur = rit.durability ?? 100; const rcost = Math.round((100 - rdur) * 0.4);
          if (u.gold < rcost) { sendTo(ws, { type: 'error', message: 'Not enough gold!' }); return; }
          u.gold -= rcost; rit.durability = 100; saveDb();
          Object.assign(player, getPlayerStats(u)); player.gold = u.gold;
          sendTo(ws, { type: 'stats_update', player, inventory: u.inventory, equipped: u.equipped });
          break;
      }
    } catch (err) { console.error('WS error:', err); }
  });

  ws.on('close', () => {
    activePlayers.delete(ws);
    if (player && marketStands.has(player.username)) { marketStands.delete(player.username); broadcastToCity({ type: 'stand_closed', owner: player.username }); }
    if (currentParty) {
      currentParty.members = currentParty.members.filter(m => m !== ws);
      if (currentParty.members.length === 0) parties.delete(currentParty.id); else pushPartyUpdate(currentParty);
    }
  });
});

server.listen(PORT, () => console.log(`Clockwork Tower running on http://localhost:${PORT}`));
