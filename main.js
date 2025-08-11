(() => {
  // --- Utility ---
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const TAU = Math.PI * 2;

  // --- Canvas Setup ---
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  let width = canvas.width, height = canvas.height;

  // --- UI Elements ---
  const phaseInfo = document.getElementById('phaseInfo');
  const weaponInfo = document.getElementById('weaponInfo');
  const ammoInfo = document.getElementById('ammoInfo');
  const creditsInfo = document.getElementById('creditsInfo');
  const hpInfo = document.getElementById('hpInfo');
  const armorInfo = document.getElementById('armorInfo');
  const roundInfo = document.getElementById('roundInfo');
  const spikeInfo = document.getElementById('spikeInfo');
  const buyMenu = document.getElementById('buyMenu');
  const toast = document.getElementById('toast');

  function showToast(msg, ms=1500){
    toast.textContent = msg;
    toast.classList.remove('hidden');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(()=>toast.classList.add('hidden'), ms);
  }

  // --- Game State ---
  const state = {
    paused: false,
    round: 1,
    maxRounds: 12,
    phase: 'buy', // 'buy' | 'live' | 'post-plant' | 'defuse' | 'win' | 'lose'
    time: 0,
    dt: 0,
    lastTime: performance.now(),
    map:{w: 2000, h: 1200, walls:[], sites:[]},
    bullets: [],
    smokes: [],
    enemies: [],
    particles: [],
    buyCredits: 800,
    spike:{holder:'player', planted:false, site:null, timer:0, plantHold:0, defuseHold:0, armed:false},
    crosshair: 1, // 1|2|3 presets
  };

  // --- Input ---
  const keys = {};
  const mouse = {x:width/2, y:height/2, down:false, right:false};
  addEventListener('keydown', e => { keys[e.key.toLowerCase()] = true; if(e.key==='b' && state.phase==='buy'){toggleBuy();} if(e.key==='p') state.paused = !state.paused; if(['1','2','3'].includes(e.key)){ state.crosshair = parseInt(e.key,10);} });
  addEventListener('keyup', e => keys[e.key.toLowerCase()] = false);
  canvas.addEventListener('mousemove', e => {
    const rect = canvas.getBoundingClientRect();
    mouse.x = e.clientX - rect.left;
    mouse.y = e.clientY - rect.top;
  });
  canvas.addEventListener('mousedown', e => { if(e.button===0) mouse.down = true; if(e.button===2) mouse.right=true; });
  canvas.addEventListener('mouseup', e => { if(e.button===0) mouse.down = false; if(e.button===2) mouse.right=false; });
  canvas.addEventListener('contextmenu', e => e.preventDefault());

  // --- Entities ---
  class Entity {
    constructor(x,y,r=16){ this.x=x; this.y=y; this.r=r; this.alive=true; }
    dist2(o){ let dx=this.x-o.x, dy=this.y-o.y; return dx*dx+dy*dy; }
  }

  class Player extends Entity {
    constructor(x,y){
      super(x,y,14);
      this.hp=100; this.armor=0;
      this.speed=210; // px/s
      this.noise=0;
      this.zoom=false;
      this.abilities={ dash:{cd:6,t:0}, smoke:{cd:12,t:0} };
      this.weapon = Weapon.create('Classic');
      this.credits = state.buyCredits;
    }
    get aimAngle(){
      return Math.atan2(mouse.y - (this.y - cam.y), mouse.x - (this.x - cam.x));
    }
    get moving(){ return keys['w']||keys['a']||keys['s']||keys['d']; }
    update(dt){
      // Movement
      let spd = this.speed * (keys['shift']?0.6:1);
      let vx = (keys['d']?1:0) - (keys['a']?1:0);
      let vy = (keys['s']?1:0) - (keys['w']?1:0);
      let len = Math.hypot(vx,vy) || 1;
      vx = vx/len*spd*dt; vy = vy/len*spd*dt;
      this.x = clamp(this.x + vx, 0, state.map.w);
      this.y = clamp(this.y + vy, 0, state.map.h);
      // Ability cooldowns
      for(const k in this.abilities){
        this.abilities[k].t = Math.max(0, this.abilities[k].t - dt);
      }
      // Shoot
      if(mouse.down && state.phase!=='buy'){
        this.weapon.tryFire(this, this.aimAngle, dt);
      }
      // ADS
      this.zoom = mouse.right && this.weapon.canZoom;
      // Reload
      if(keys['r']){ this.weapon.reload(); keys['r']=false; }
      // Dash
      if(keys[' '] && this.abilities.dash.t<=0){
        const dashLen = 120;
        this.x = clamp(this.x + Math.cos(this.aimAngle)*dashLen, 0, state.map.w);
        this.y = clamp(this.y + Math.sin(this.aimAngle)*dashLen, 0, state.map.h);
        this.abilities.dash.t = this.abilities.dash.cd;
        particlesBurst(this.x,this.y, 8, '#8cf');
        showToast('ダッシュ!', 600);
        keys[' '] = false;
      }
      // Smoke
      if(keys['e'] && this.abilities.smoke.t<=0){
        state.smokes.push( new Smoke(this.x + Math.cos(this.aimAngle)*180, this.y + Math.sin(this.aimAngle)*180) );
        this.abilities.smoke.t = this.abilities.smoke.cd;
        showToast('スモーク展開', 600);
        keys['e']=false;
      }
      // Spike
      if(keys['g']){
        if(!state.spike.planted && insideSite(this) && state.spike.holder==='player'){
          state.spike.plantHold += dt;
          showToast(`設置中… ${(state.spike.plantHold).toFixed(1)} / 4s`, 200);
          if(state.spike.plantHold>=4){
            state.spike.planted=true;
            state.spike.site = getSiteAt(this);
            state.spike.timer=45;
            state.phase='post-plant';
            showToast('スパイク設置！', 1200);
          }
        } else if(state.spike.planted && !state.spike.defused && distTo(this, state.spike.site)>0 && nearSpike(this)){
          state.spike.defuseHold += dt;
          showToast(`解除中… ${(state.spike.defuseHold).toFixed(1)} / 7s`, 200);
          if(state.spike.defuseHold>=7){
            state.spike.defused=true;
            state.phase='win';
            showToast('解除成功！ ラウンド勝利', 1500);
          }
        }
      } else {
        state.spike.plantHold=0;
        state.spike.defuseHold=0;
      }
      // Update UI
      weaponInfo.textContent = `武器: ${this.weapon.name}`;
      ammoInfo.textContent = `弾薬: ${this.weapon.mag} / ${this.weapon.reserve}`;
      creditsInfo.textContent = `クレジット: ${this.credits}`;
      hpInfo.textContent = `HP: ${this.hp}`;
      armorInfo.textContent = `アーマー: ${this.armor}`;
      spikeInfo.textContent = state.spike.planted? `スパイク: 設置済（${state.spike.timer.toFixed(0)}s）` : (state.spike.holder==='player'?'スパイク: 所持':'スパイク: 未所持');
    }
    draw(){
      // Player body
      ctx.save();
      ctx.translate(this.x - cam.x, this.y - cam.y);
      // Body
      ctx.fillStyle = '#cfe8ff';
      ctx.beginPath(); ctx.arc(0,0,this.r,0,TAU); ctx.fill();
      // Facing line
      ctx.strokeStyle = '#7fb0ff';
      ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(20,0); ctx.stroke();
      ctx.restore();
    }
  }

  class Enemy extends Entity {
    constructor(x,y){
      super(x,y,14);
      this.hp=100;
      this.state='patrol'; // 'patrol' | 'chase' | 'smoked'
      this.target={x:x,y:y};
      this.reloadT=0;
      this.weapon = Weapon.create('Vandal');
      this.hearTimer=0;
      this.fov= Math.PI*0.7;
    }
    update(dt){
      if(!this.alive) return;
      // Simple AI: if player in FOV and not in smoke, chase + shoot
      const inSmoke = state.smokes.some(s=>s.contains(this.x,this.y));
      if(inSmoke){ this.state='smoked'; }
      else {
        const ang = Math.atan2(player.y-this.y, player.x-this.x);
        const dist = Math.hypot(player.x-this.x, player.y-this.y);
        if(dist<600 && lineOfSight(this, player)){
          this.state='chase';
          // Shoot with some reaction time
          this.weapon.tryFire(this, ang + (Math.random()-0.5)*0.05, dt);
        } else {
          if(this.state==='chase') this.state='patrol';
        }
      }
      // Movement
      let speed = (this.state==='chase'? 160 : 100);
      // Random walk / approach player a bit
      if(this.state==='chase'){
        const dx = player.x - this.x, dy = player.y - this.y;
        const d = Math.hypot(dx,dy)||1;
        this.x += dx/d * speed*dt * 0.6;
        this.y += dy/d * speed*dt * 0.6;
      } else {
        // small wiggle
        this.x += (Math.random()-0.5)*40*dt;
        this.y += (Math.random()-0.5)*40*dt;
      }
      this.x = clamp(this.x,0,state.map.w); this.y = clamp(this.y,0,state.map.h);
    }
    draw(){
      if(!this.alive) return;
      ctx.save();
      ctx.translate(this.x - cam.x, this.y - cam.y);
      ctx.fillStyle = '#f6b3b3';
      ctx.beginPath(); ctx.arc(0,0,this.r,0,TAU); ctx.fill();
      ctx.strokeStyle = '#ff8b8b';
      ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(20,0); ctx.stroke();
      ctx.restore();
    }
  }

  class Smoke {
    constructor(x,y){ this.x=x; this.y=y; this.r=90; this.t=3; }
    update(dt){ this.t -= dt; }
    get alive(){ return this.t>0; }
    contains(x,y){ return Math.hypot(this.x-x, this.y-y) < this.r; }
    draw(){
      const alpha = clamp(this.t/3, 0, 1)*0.6+0.2;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#6aa0ff';
      ctx.beginPath(); ctx.arc(this.x - cam.x, this.y - cam.y, this.r, 0, TAU); ctx.fill();
      ctx.restore();
    }
  }

  // --- Weapons ---
  const WEAPONS = {
    'Classic': { dmgBody:26, dmgHead:78, rpm:400, magSize:12, reserve:36, reload:1.5, spread:0.055, moveSpread:0.09, zoom:false, bullets:1, recoilKick:0.015 },
    'Ghost':   { dmgBody:30, dmgHead:105, rpm:400, magSize:15, reserve:45, reload:1.7, spread:0.04, moveSpread:0.07, zoom:false, bullets:1, recoilKick:0.02 },
    'Vandal':  { dmgBody:39, dmgHead:156, rpm:540, magSize:25, reserve:75, reload:2.2, spread:0.06, moveSpread:0.12, zoom:true, bullets:1, recoilKick:0.026 },
    'Bulldog': { dmgBody:35, dmgHead:116, rpm:600, magSize:24, reserve:72, reload:2.2, spread:0.07, moveSpread:0.13, zoom:true, bullets:1, recoilKick:0.028 },
    'Marshal': { dmgBody:101, dmgHead:202, rpm:90,  magSize:5,  reserve:15, reload:2.0, spread:0.01, moveSpread:0.02, zoom:true, bullets:1, recoilKick:0.0 }
  };

  class Weapon {
    static create(name){
      const s = WEAPONS[name];
      const w = new Weapon();
      w.name = name;
      w.dmgBody = s.dmgBody; w.dmgHead = s.dmgHead;
      w.fireDelay = 60/s.rpm;
      w.mag = s.magSize; w.magSize = s.magSize; w.reserve = s.reserve;
      w.reloadTime = s.reload; w.reloadT = 0;
      w.baseSpread = s.spread; w.moveSpread = s.moveSpread;
      w.canZoom = s.zoom; w.zoom = false;
      w.shotsPerBullet = s.bullets;
      w.recoil = 0;
      w.recoilKick = s.recoilKick;
      w.cooldown = 0;
      return w;
    }
    reload(){
      if(this.mag===this.magSize || this.reserve<=0 || this.reloadT>0) return;
      this.reloadT = this.reloadTime;
      showToast('リロード中…');
    }
    tryFire(owner, angle, dt){
      if(this.reloadT>0){ return; }
      this.cooldown -= dt;
      if(this.cooldown>0) return;
      if(this.mag<=0){ this.reload(); return; }
      // Fire
      this.mag--;
      this.cooldown = this.fireDelay;
      const moving = owner instanceof Player ? owner.moving : false;
      const spread = (this.baseSpread + (moving? this.moveSpread:0) + this.recoil);
      this.recoil = clamp(this.recoil + this.recoilKick, 0, 0.12);
      setTimeout(()=>{ this.recoil = Math.max(0, this.recoil - 0.08); }, 80);

      for(let i=0;i<this.shotsPerBullet;i++){
        const a = angle + (Math.random()-0.5)*spread;
        const speed = 1400;
        state.bullets.push(new Bullet(owner, owner.x, owner.y, Math.cos(a)*speed, Math.sin(a)*speed, (owner.zoom?0.4:1)));
      }
      muzzleFlash(owner.x, owner.y);
    }
    update(dt){
      if(this.reloadT>0){
        this.reloadT -= dt;
        if(this.reloadT<=0){
          const need = this.magSize - this.mag;
          const take = Math.min(need, this.reserve);
          this.mag += take; this.reserve -= take;
          showToast('リロード完了', 700);
        }
      }
    }
  }

  class Bullet {
    constructor(owner,x,y,vx,vy, falloff=1){
      this.owner=owner; this.x=x; this.y=y; this.vx=vx; this.vy=vy; this.alive=true; this.life=1.0; this.falloff=falloff;
    }
    update(dt){
      if(!this.alive) return;
      this.x += this.vx*dt; this.y += this.vy*dt;
      this.life -= dt*1.7;
      if(this.x<0||this.y<0||this.x>state.map.w||this.y>state.map.h) this.alive=false;
      // collide with walls
      for(const w of state.map.walls){
        if(pointInRect(this.x,this.y,w)){
          this.alive=false;
          return;
        }
      }
      // hit test
      const targets = (this.owner===player) ? state.enemies : [player];
      for(const t of targets){
        if(!t.alive) continue;
        const d = Math.hypot(this.x-t.x,this.y-t.y);
        if(d < t.r){
          this.alive=false;
          const headshot = (Math.abs(this.y - t.y) < t.r*0.5);
          const wpn = this.owner.weapon;
          const dmg = headshot? wpn.dmgHead : wpn.dmgBody;
          damage(t, dmg);
          particlesBurst(this.x,this.y, 6, headshot? '#ffef8b' : '#f45');
          break;
        }
      }
    }
    draw(){
      if(!this.alive) return;
      ctx.save();
      ctx.globalAlpha = clamp(this.life, 0, 1);
      ctx.fillStyle='#fff';
      ctx.beginPath(); ctx.arc(this.x - cam.x, this.y - cam.y, 2, 0, TAU); ctx.fill();
      ctx.restore();
    }
  }

  function damage(ent, amount){
    if(!ent.alive) return;
    let remaining = amount;
    if(ent.armor && ent.armor>0){
      const absorb = Math.min(ent.armor, remaining*0.7);
      ent.armor -= absorb;
      remaining -= absorb;
    }
    ent.hp -= remaining;
    if(ent.hp<=0){ ent.alive=false; particlesBurst(ent.x, ent.y, 18, '#f88'); }
  }

  // --- Map / Geometry ---
  function pointInRect(x,y, r){ return x>=r.x && y>=r.y && x<=r.x+r.w && y<=r.y+r.h; }
  function distTo(a,b){ return Math.hypot(a.x-b.x, a.y-b.y); }

  const cam = {x:0,y:0};
  function updateCamera(){
    cam.x = clamp(player.x - width/2, 0, state.map.w - width);
    cam.y = clamp(player.y - height/2, 0, state.map.h - height);
  }

  function buildMap(){
    const m = state.map;
    m.walls.length=0; m.sites.length=0;
    // Outer walls
    m.walls.push({x:0,y:0,w:m.w,h:20},{x:0,y:m.h-20,w:m.w,h:20},{x:0,y:0,w:20,h:m.h},{x:m.w-20,y:0,w:20,h:m.h});
    // Inner cover
    m.walls.push({x:300,y:200,w:260,h:40},{x:620,y:300,w:40,h:280},{x:950,y:180,w:280,h:40},{x:1200,y:540,w:40,h:280},
                 {x:1500,y:300,w:300,h:40},{x:1500,y:700,w:300,h:40},{x:800,y:800,w:260,h:40});
    // Sites
    m.sites.push({name:'A', x:420, y:460, w:200, h:160});
    m.sites.push({name:'B', x:1520, y:520, w:220, h:180});
  }

  function drawMap(){
    // Background grid
    ctx.fillStyle='#0f141c'; ctx.fillRect(0,0,width,height);
    const gridSize = 40;
    ctx.strokeStyle='#15202e'; ctx.lineWidth=1;
    ctx.beginPath();
    for(let x= - (cam.x%gridSize); x<width; x+=gridSize){ ctx.moveTo(x,0); ctx.lineTo(x,height); }
    for(let y= - (cam.y%gridSize); y<height; y+=gridSize){ ctx.moveTo(0,y); ctx.lineTo(width,y); }
    ctx.stroke();
    // Sites
    for(const s of state.map.sites){
      ctx.fillStyle='rgba(50,180,120,0.12)';
      ctx.fillRect(s.x - cam.x, s.y - cam.y, s.w, s.h);
      ctx.strokeStyle='rgba(50,180,120,0.5)';
      ctx.strokeRect(s.x - cam.x, s.y - cam.y, s.w, s.h);
      ctx.fillStyle='rgba(200,255,230,0.7)';
      ctx.fillText(`Site ${s.name}`, s.x - cam.x + 6, s.y - cam.y + 14);
    }
    // Walls
    ctx.fillStyle='#243040';
    for(const w of state.map.walls){
      ctx.fillRect(w.x - cam.x, w.y - cam.y, w.w, w.h);
    }
  }

  function insideSite(ent){
    return !!getSiteAt(ent);
  }
  function getSiteAt(ent){
    return state.map.sites.find(s => pointInRect(ent.x, ent.y, s));
  }
  function nearSpike(ent){
    if(!state.spike.site) return false;
    const s = state.spike.site;
    const sx = s.x + s.w/2, sy = s.y + s.h/2;
    return Math.hypot(ent.x - sx, ent.y - sy) < 80;
  }

  function lineOfSight(a,b){
    // Very simple LOS: check bullets against walls as line segments by sampling
    const steps = 20;
    for(let i=1;i<=steps;i++){
      const x = lerp(a.x,b.x,i/steps);
      const y = lerp(a.y,b.y,i/steps);
      for(const w of state.map.walls){
        if(pointInRect(x,y,w)) return false;
      }
    }
    // smoke blocks 
    for(const s of state.smokes){ if(s.contains( (a.x+b.x)/2, (a.y+b.y)/2 )) return false; }
    return true;
  }

  // --- Particles ---
  function particlesBurst(x,y,n,color){
    for(let i=0;i<n;i++){
      state.particles.push({
        x,y, vx:(Math.random()-0.5)*260, vy:(Math.random()-0.5)*260,
        life: Math.random()*0.4+0.2, color
      });
    }
  }
  function muzzleFlash(x,y){
    particlesBurst(x,y,3,'#ffd077');
  }

  // --- Buy Menu ---
  function toggleBuy(){
    buyMenu.classList.toggle('hidden');
  }
  document.querySelectorAll('.buy').forEach(btn => {
    btn.addEventListener('click', () => {
      const w = btn.dataset.weapon;
      const armor = btn.dataset.armor;
      const cost = parseInt(btn.dataset.cost||'0',10);
      if(state.phase!=='buy'){ showToast('購入フェーズではありません'); return; }
      if(player.credits < cost){ showToast('クレジット不足'); return; }
      if(w){
        player.weapon = Weapon.create(w);
        player.credits -= cost;
        showToast(`${w} を購入`, 700);
      } else if(armor){
        if(armor==='light'){ player.armor=25; }
        if(armor==='heavy'){ player.armor=50; }
        player.credits -= cost;
        showToast(`アーマー購入`, 700);
      }
      creditsInfo.textContent = `クレジット: ${player.credits}`;
    });
  });
  document.getElementById('closeBuy').addEventListener('click', toggleBuy);

  // --- Round / Enemies ---
  function spawnEnemies(n=4){
    state.enemies.length=0;
    for(let i=0;i<n;i++){
      const e = new Enemy(1300 + Math.random()*500, 400 + Math.random()*300);
      state.enemies.push(e);
    }
  }
  function startRound(){
    state.phase='buy';
    phaseInfo.textContent='フェーズ: 購入';
    state.buyCredits = (state.round===1?800: (player.credits + 1800));
    player.credits = state.buyCredits;
    player.x=260; player.y=420; player.hp=100; player.armor = player.armor || 0;
    player.weapon = player.weapon || Weapon.create('Classic');
    state.spike = {holder:'player', planted:false, site:null, timer:0, plantHold:0, defuseHold:0, armed:false};
    spawnEnemies(4 + Math.floor(state.round/3));
    toggleBuy(); // open
  }
  function goLive(){
    state.phase='live'; phaseInfo.textContent='フェーズ: ライブ';
    buyMenu.classList.add('hidden');
    showToast('ラウンド開始');
  }
  function endRound(win){
    state.phase = win ? 'win' : 'lose';
    showToast(win? 'ラウンド勝利' : 'ラウンド敗北', 1200);
    setTimeout(()=>{
      state.round++;
      if(state.round>state.maxRounds){ showToast('試合終了。お疲れさま！', 2000); return; }
      roundInfo.textContent = `ラウンド: ${state.round} / ${state.maxRounds}`;
      startRound();
    }, 1400);
  }

  // --- World Setup ---
  buildMap();
  const player = new Player(260, 420);
  startRound();

  // --- Main Loop ---
  function loop(now){
    const dt = Math.min(0.033, (now - state.lastTime)/1000);
    state.lastTime = now;
    if(state.paused){ requestAnimationFrame(loop); return; }
    state.time += dt;
    // Timers
    if(state.phase==='buy' && state.time>2){ // auto start after a short moment if menu is closed
      if(buyMenu.classList.contains('hidden') && !autoStart._done){
        autoStart._done = true;
        goLive();
      }
    }
    // Transition: press B to close and start live
    if(state.phase==='buy' && buyMenu.classList.contains('hidden')){
      goLive();
    }

    // Update
    player.weapon.update(dt);
    player.update(dt);
    for(const e of state.enemies) e.update(dt);
    for(const b of state.bullets) b.update(dt);
    state.bullets = state.bullets.filter(b=>b.alive);
    for(const s of state.smokes) s.update(dt);
    state.smokes = state.smokes.filter(s=>s.alive);
    for(const p of state.particles){
      p.x+=p.vx*dt; p.y+=p.vy*dt; p.life-=dt;
    }
    state.particles = state.particles.filter(p=>p.life>0);

    // Spike timer
    if(state.spike.planted){
      state.spike.timer -= dt;
      if(state.spike.timer<=0){ endRound(false); }
      phaseInfo.textContent='フェーズ: ポストプラント';
    } else if(state.enemies.every(e=>!e.alive)){ endRound(true); }

    updateCamera();

    // Draw
    ctx.clearRect(0,0,width,height);
    drawMap();
    // Spike icon
    if(state.spike.planted){
      const s = state.spike.site;
      const sx = s.x + s.w/2 - cam.x, sy = s.y + s.h/2 - cam.y;
      ctx.fillStyle='rgba(255,80,80,0.8)'; ctx.beginPath(); ctx.arc(sx,sy,8,0,TAU); ctx.fill();
      ctx.fillStyle='#ffb0b0'; ctx.fillText(state.spike.timer.toFixed(1)+'s', sx+10, sy-10);
    }
    // Smokes
    for(const s of state.smokes) s.draw();
    // Bullets
    for(const b of state.bullets) b.draw();
    // Enemies
    for(const e of state.enemies) e.draw();
    // Player
    player.draw();

    // Particles
    for(const p of state.particles){
      ctx.globalAlpha = clamp(p.life/0.6, 0, 1);
      ctx.fillStyle = p.color; ctx.fillRect(p.x - cam.x, p.y - cam.y, 2,2);
      ctx.globalAlpha = 1;
    }

    // Crosshair
    drawCrosshair();

    requestAnimationFrame(loop);
  }
  const autoStart = {_done:false};
  requestAnimationFrame(loop);

  function drawCrosshair(){
    const cx = mouse.x, cy = mouse.y;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.strokeStyle = '#d1e3ff'; ctx.lineWidth = 2;
    if(state.crosshair===1){
      ctx.beginPath(); ctx.moveTo(-14,0); ctx.lineTo(-4,0); ctx.moveTo(14,0); ctx.lineTo(4,0);
      ctx.moveTo(0,-14); ctx.lineTo(0,-4); ctx.moveTo(0,14); ctx.lineTo(0,4); ctx.stroke();
    } else if(state.crosshair===2){
      ctx.beginPath(); ctx.arc(0,0,6,0,TAU); ctx.stroke();
    } else {
      ctx.beginPath(); ctx.moveTo(-18,0); ctx.lineTo(-3,0); ctx.moveTo(18,0); ctx.lineTo(3,0);
      ctx.moveTo(0,-18); ctx.lineTo(0,-3); ctx.moveTo(0,18); ctx.lineTo(0,3); ctx.stroke();
    }
    ctx.restore();
  }

  // Resize handling
  function onResize(){
    // keep 16:9
    const w = window.innerWidth;
    const h = window.innerHeight;
    let cw = w, ch = h;
    if(w/h > 16/9){ cw = h*16/9; } else { ch = w*9/16; }
    canvas.style.width = cw+'px'; canvas.style.height = ch+'px';
  }
  window.addEventListener('resize', onResize);
  onResize();

  // Helpers for UI texts initially
  roundInfo.textContent = `ラウンド: ${state.round} / ${state.maxRounds}`;
  phaseInfo.textContent = 'フェーズ: 購入';

  // Disclaimer
  console.log('This demo is original and uses no third-party assets. It is an homage to tactical shooter mechanics.');
})();