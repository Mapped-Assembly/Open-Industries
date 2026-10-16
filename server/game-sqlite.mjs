import { randomUUID } from 'node:crypto';
import { tsImport } from 'tsx/esm/api';
import { gameDomainModule,nativeGame,packGame,advanceGame } from './domains/game-core.mjs';
const { DomainRegistry,DomainCommandError } = await tsImport('./simulation/registry.ts',import.meta.url);
import { gameContract, gameFail, validateGameRequest, validateGameResult } from './mcp-game-contract.mjs';
import { VersionedGameDomain, gameRulePin as historyRule, canonical } from './domains/game.mjs';
import { executeTransactionalCommand, SimulationCommandError } from './simulation/commands.mjs';
import { copyJson } from './simulation/json.mjs';
import { SqliteEventHistory } from './simulation/events.mjs';
export { canonical, cablePlan } from './domains/game.mjs';

/** No external IO inside transactions. SQLite serializes writers across processes. */
export class GameDatabase extends VersionedGameDomain {
  constructor(path, { clock = Date.now } = {}) {
    super(path,{clock,supportedVersions:[0,1,2,3,4,5,6,7,8]});
    const version=Number(this.db.prepare('PRAGMA user_version').get().user_version);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS matches(id TEXT PRIMARY KEY, host TEXT NOT NULL REFERENCES accounts(id), status TEXT NOT NULL, created INTEGER NOT NULL, last_tick INTEGER NOT NULL, state TEXT NOT NULL CHECK(json_valid(state)));
      CREATE INDEX IF NOT EXISTS matches_due ON matches(status,last_tick);
      CREATE TABLE IF NOT EXISTS members(match_id TEXT NOT NULL REFERENCES matches(id), owner TEXT NOT NULL REFERENCES accounts(id), slot INTEGER NOT NULL CHECK(slot IN(1,2)), PRIMARY KEY(match_id,owner), UNIQUE(match_id,slot));
      CREATE INDEX IF NOT EXISTS members_owner ON members(owner);
      CREATE TABLE IF NOT EXISTS receipts(owner TEXT NOT NULL REFERENCES accounts(id), command_id TEXT NOT NULL, match_id TEXT NOT NULL REFERENCES matches(id), request TEXT NOT NULL, result TEXT NOT NULL CHECK(json_valid(result)), PRIMARY KEY(owner,command_id));
      CREATE INDEX IF NOT EXISTS receipts_match ON receipts(match_id,owner);

    `);
    // Envelopes include a resource replay tail; bound full post-state history to keep auth responsive.
    this.history = new SqliteEventHistory(this.db,{maxEvents:64,maxBytes:2*1024*1024});
    this.registry = new DomainRegistry(); this.registry.register(gameDomainModule(code=>{throw new DomainCommandError(code);}));
    this.viewInstances = new WeakMap();
    // Initialize the old cutover first, then record real upgrades atomically with state.
    try { this.transaction(() => {
      for (const row of this.db.prepare('SELECT state FROM matches').all()) {
        const stored = JSON.parse(row.state);
        if(stored.contract_version===1){
          this.registry.validateInstance(stored);
          this.history.initialize({instance_id:stored.id,rule:historyRule,simulation_time_ms:stored.simulation_time_ms,revision:stored.revision,state:stored});
          continue;
        }
        if(version>=5)throw Error('ENVELOPE_REQUIRED');
        const match=stored;
        if (version < 2) this.upgradeLegacy(match);
        this.history.initialize({instance_id:match.id,rule:historyRule,simulation_time_ms:match.last_advanced_ms,revision:match.revision,state:match});
        if (version < 3) this.upgradeScience(match);
        if (version < 4) this.upgradeRobots(match);
        this.validateCurrentState(match);
        this.saveInstance(packGame(match),{kind:'worker',id:'shared-core-cutover',principal_id:null},'shared-core-cutover');
      }
      this.db.exec('PRAGMA user_version=8');
    }); } catch(error) { this.db.close();throw new Error('UNSUPPORTED_GAME_SAVE: restore a compatible backup or run the exact game module version that wrote this database.',{cause:error}); }
  }

  quota(owner,creating) {
    const rows=this.db.prepare('SELECT m.state FROM matches m JOIN members p ON p.match_id=m.id WHERE p.owner=?').all(owner);
    const open=rows.map(row=>{const state=JSON.parse(row.state);return state.contract_version===1?nativeGame(state):state;}).filter(m=>m.status==='active'||(m.status==='waiting'&&m.invite_expires>this.clock()));
    if(open.length>=3||(creating&&this.db.prepare('SELECT count(*) n FROM matches WHERE host=? AND created>?').get(owner,this.clock()-86400000).n>=20))gameFail('LIMIT_REACHED');
  }
  /** Canonical persisted envelope; native callers receive only a lossless compatibility view. */
  loadInstance(id) {
    const row=this.db.prepare('SELECT state FROM matches WHERE id=?').get(id);
    if(!row)gameFail('NOT_AVAILABLE');
    const instance=JSON.parse(row.state);this.registry.validateInstance(instance);return instance;
  }
  load(id) {
    const instance=this.loadInstance(id),match=nativeGame(instance);
    this.viewInstances.set(match,instance);return match;
  }
  /** Advance through the same bounded clock driver used by neutral jobs. */
  advance(match) {
    // Pre-envelope legacy upgrades must settle under their original rules before cutover.
    const previous=this.viewInstances.get(match);
    if(!previous)return super.advance(match);
    const next=advanceGame(previous,this.clock(),1000),view=nativeGame(next);
    for(const key of Object.keys(match))delete match[key];Object.assign(match,view);
    this.viewInstances.set(match,next);
  }
  save(match,source={kind:'worker',id:'advance',principal_id:null},action='advance') {
    if(!this.db.isTransaction)return this.transaction(()=>this.save(match,source,action));
    this.prepareState(match);this.assertState(match);
    const prior=this.viewInstances.get(match);
    const instance=packGame(match,prior,{id:`save:${source.kind}:${source.id}:${prior?.state.resources.sequence??0}`,actor:{kind:source.kind==='command'?'command':'worker',principal_id:source.principal_id}});
    this.saveInstance(instance,source,action);this.viewInstances.set(match,instance);
  }
  saveInstance(instance,source,action) {
    this.registry.validateInstance(instance);
    this.history.initialize({instance_id:instance.id,rule:historyRule,simulation_time_ms:instance.simulation_time_ms,revision:instance.revision,state:instance});
    const previous=this.history.replay(instance.id),match=nativeGame(instance);
    this.db.prepare('UPDATE matches SET status=?,last_tick=?,state=? WHERE id=?').run(match.status,instance.simulation_time_ms,JSON.stringify(instance),instance.id);
    if(source.kind==='command'||canonical(previous.state)!==canonical(instance))this.history.append({
      instance_id:instance.id,expected_sequence:previous.sequence,rule:historyRule,simulation_time_ms:instance.simulation_time_ms,revision:instance.revision,
      source,links:this.historyLinks(match,{...previous,state:previous.state.contract_version===1?nativeGame(previous.state):previous.state}),provenance:{origin:'simulated',validity:'modeled',evidence:[]},
      units:[{field:'simulation_time',unit:'ms'},{field:'mass',unit:'g'},{field:'energy',unit:'mJ'}],payload:{action},state:instance,
    });
  }
  /** Authorized schema-checked current projection; bounded debt disables native mutations. */
  projectInstance(instance,owner) {
    const snapshot=this.registry.project(instance,owner);
    snapshot.scheduler_healthy=this.healthy()&&instance.state.schedule.cursor_ms===instance.state.schedule.observed_at_ms;
    snapshot.server_time_ms=Math.max(this.clock(),instance.simulation_time_ms);return snapshot;
  }
  snapshot(match,owner) {
    const instance=this.viewInstances.get(match);
    if(instance)return this.projectInstance(instance,owner);
    return super.snapshot(match,owner);
  }
  historyProjection() {
    const old=super.historyProjection(),view=state=>state.contract_version===1?nativeGame(state):state;
    return {...old,version:'game-history-v3',
      authorize:(state,owner)=>old.authorize(view(state),owner),
      validateState:(state,rule)=>{if(state.contract_version===1){if(canonical(rule)!==canonical(historyRule))gameFail('INVARIANT_FAILED');this.registry.validateInstance(state);}else old.validateState(state,rule);},
      snapshot:(state,owner,at)=>old.snapshot(view(state),owner,at),
      event:(event,owner)=>old.event({...event,state:view(event.state)},owner),
    };
  }
  /** Additive history transport: authenticate now, project every historical value independently. */
  historyPage(token, request) {
    return this.transaction(() => {
      const owner = this.identity(token);
      return this.history.read(request,owner,this.historyProjection());
    });
  }
  tick() {
    this.transaction(() => {
      const rows = this.db.prepare("SELECT state FROM matches WHERE status IN ('active','waiting') ORDER BY last_tick,id LIMIT 100").all();
      for (const row of rows) { const match = this.load(JSON.parse(row.state).id); this.advance(match); this.save(match); }
      this.db.prepare('UPDATE runtime SET heartbeat=? WHERE id=1').run(this.clock());
      this.db.prepare('DELETE FROM sessions WHERE expires<=?').run(this.clock());
    });
  }
  commandThroughCore(token,name,args) {
    let invite=null;
    try {
      return executeTransactionalCommand({command_id:args.command_id,instance_id:args.match_id,expected_revision:args.expected_revision,action:args.action,payload:Object.fromEntries(Object.entries(args).filter(([key])=>!['version','command_id','match_id','expected_revision','action'].includes(key)))},{
        transaction:work=>this.transaction(work),authenticate:()=>this.identity(token),
        load:id=>this.loadInstance(id),instanceId:instance=>instance.id,revision:instance=>instance.revision,
        setRevision:(instance,revision)=>{instance.revision=revision;},
        authorized:(instance,owner)=>instance.members.some(m=>m.principal_id===owner),
        now:instance=>Math.max(this.clock(),instance.simulation_time_ms),requestKey:()=>canonical({name,arguments:args}),
        receipt:(owner,id)=>{const r=this.db.prepare('SELECT request,result FROM receipts WHERE owner=? AND command_id=?').get(owner,id);return r?{request:r.request,result:JSON.parse(r.result)}:undefined;},
        prepare:instance=>{const next=advanceGame(instance,this.clock(),1000);if(next.state.schedule.cursor_ms!==next.state.schedule.observed_at_ms)gameFail('SCHEDULER_UNAVAILABLE');return next;},
        apply:(instance,command,context)=>{
          this.checkMutation(nativeGame(instance),context.principal_id,command.action);
          const payload={...command.payload};if(command.action==='rotate_invite'){invite=randomUUID();payload.invite_code=invite;}
          const proposed=this.registry.transition(instance,context.principal_id,{...command,payload,expected_revision:instance.revision});
          return {state:{...instance,state:proposed.state,entities:proposed.entities??instance.entities,observations:proposed.observations??instance.observations},events:proposed.events};
        },
        validate:instance=>this.registry.validateInstance(instance),
        result:(instance,command,context)=>validateGameResult(name,{version:gameContract.version,balance_version:gameContract.balance_version,snapshot:this.projectInstance(instance,context.principal_id),command_id:command.command_id,invite_code:invite}),
        save:instance=>this.saveInstance(instance,{kind:'command',id:args.command_id,principal_id:this.identity(token)},args.action),
        saveReceipt:(owner,command,request,result)=>this.db.prepare('INSERT INTO receipts VALUES(?,?,?,?,?)').run(owner,command.command_id,command.instance_id,request,JSON.stringify(result)),
      });
    }catch(error){if(error instanceof DomainCommandError)gameFail(error.code);if(error instanceof SimulationCommandError)gameFail(error.code==='EVENTS_UNSUPPORTED'?'INVARIANT_FAILED':error.code);throw error;}
  }
  /** Older protocols may only replay an already committed, byte-identical native intent. */
  legacyReceipt(token, name, raw) {
    const args = copyJson(raw, () => gameFail('INVALID_REQUEST'));
    if (!['astra.game_create_match','astra.game_join_match','astra.game_command'].includes(name)
      || typeof args.command_id !== 'string') gameFail('INVALID_REQUEST');
    return this.transaction(() => {
      const owner = this.identity(token);
      const receipt = this.db.prepare('SELECT * FROM receipts WHERE owner=? AND command_id=?').get(owner,args.command_id);
      if (!receipt) gameFail('INVALID_REQUEST');
      if (receipt.request !== canonical({name,arguments:args})) gameFail('COMMAND_ID_REUSED');
      if (!this.member(this.load(receipt.match_id),owner)) gameFail('NOT_AVAILABLE');
      return JSON.parse(receipt.result);
    });
  }
  dispatch(token, name, raw) {
    if ([2,3,4].includes(raw?.version)) return this.legacyReceipt(token,name,raw);
    const args = validateGameRequest(name, raw);
    if (name === 'astra.game_describe') gameFail('INVALID_REQUEST');
    if (name === 'astra.game_command') return this.commandThroughCore(token,name,args);
    return this.transaction(() => {
      const owner = this.identity(token), operation = name.replace('astra.game_', '');
      const request = canonical({ name, arguments: args });
      const readOnly = ['read_match','science_catalog','evaluate','manufacturing_catalog','manufacturing_preview'].includes(operation);
      if (operation === 'list_matches') {
        const rows = this.db.prepare('SELECT m.state,m.created,p.slot FROM matches m JOIN members p ON p.match_id=m.id WHERE p.owner=? AND (? IS NULL OR m.id>?) ORDER BY m.id LIMIT 21').all(owner, args.cursor, args.cursor);
        const matches = rows.slice(0, 20).map(row => { const m = this.load(JSON.parse(row.state).id); this.advance(m); this.save(m); return { match_id: m.id, status: m.status, slot: row.slot, created_at_ms: row.created }; });
        return validateGameResult(name, { version: gameContract.version, matches, next_cursor: rows.length > 20 ? matches.at(-1).match_id : null });
      }
      if (!readOnly) {
        const receipt = this.db.prepare('SELECT * FROM receipts WHERE owner=? AND command_id=?').get(owner, args.command_id);
        if (receipt) { if (receipt.request !== request) gameFail('COMMAND_ID_REUSED'); return JSON.parse(receipt.result); }
      }
      let match, invite;
      if (operation === 'create_match') {
        this.quota(owner, true);
        if (!this.healthy()) gameFail('SCHEDULER_UNAVAILABLE');
        invite = randomUUID();
        match = this.newMatch(owner,invite);
        this.db.prepare('INSERT INTO matches VALUES(?,?,?,?,?,?)').run(match.id, owner, match.status, this.clock(), match.last_advanced_ms, JSON.stringify(match));
        this.db.prepare('INSERT INTO members VALUES(?,?,1)').run(match.id, owner);
      } else {
        match = this.load(args.match_id);
        const own = this.member(match,owner);
        if (operation === 'join_match') {
          this.checkJoin(match,owner,args.invite_code);
          this.quota(owner, false);
        } else {
          if (!own) gameFail('NOT_AVAILABLE');
          if (operation === 'command' && match.revision !== args.expected_revision) gameFail('CONFLICT');
        }
        this.advance(match);
        if (['science_catalog','evaluate','manufacturing_catalog','manufacturing_preview'].includes(operation)) {
          const result = this.scienceRead(match,owner,operation,args);
          this.save(match);
          return validateGameResult(name,result);
        }
        if (!readOnly) {
          const action = operation === 'command' ? args.action : operation;
          this.checkMutation(match, owner, action);
          if (action === 'join_match') {
            this.join(match,owner);
            this.db.prepare('INSERT INTO members VALUES(?,?,2)').run(match.id, owner);
          } else if (action === 'rotate_invite') {
            invite=randomUUID();this.rotate(match,owner,invite);
          } else this.command(match, own, args);
          match.revision++;
        }
      }
      this.save(match, readOnly ? {kind:'worker',id:'read-advance',principal_id:null}
        : {kind:'command',id:args.command_id,principal_id:owner}, operation === 'command' ? args.action : operation);
      const result = { version: gameContract.version, balance_version: 'dump-world-v1', snapshot: this.snapshot(match, owner),
        ...(!readOnly ? { command_id: args.command_id } : {}), ...(operation === 'command' || invite ? { invite_code: invite ?? null } : {}) };
      validateGameResult(name, result);
      if (!readOnly) this.db.prepare('INSERT INTO receipts VALUES(?,?,?,?,?)').run(owner, args.command_id, match.id, request, JSON.stringify(result));
      return result;
    });
  }

}
