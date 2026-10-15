import { randomUUID } from 'node:crypto';
import { gameContract, gameFail, validateGameRequest, validateGameResult } from './mcp-game-contract.mjs';
import { VersionedGameDomain, gameRulePin as historyRule, canonical } from './domains/game.mjs';
import { executeTransactionalCommand, SimulationCommandError } from './simulation/commands.mjs';
import { SqliteEventHistory } from './simulation/events.mjs';
export { canonical, cablePlan } from './domains/game.mjs';

/** No external IO inside transactions. SQLite serializes writers across processes. */
export class GameDatabase extends VersionedGameDomain {
  constructor(path, { clock = Date.now } = {}) {
    super(path,{clock,supportedVersions:[0,1,2]});
    const version=Number(this.db.prepare('PRAGMA user_version').get().user_version);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS matches(id TEXT PRIMARY KEY, host TEXT NOT NULL REFERENCES accounts(id), status TEXT NOT NULL, created INTEGER NOT NULL, last_tick INTEGER NOT NULL, state TEXT NOT NULL CHECK(json_valid(state)));
      CREATE INDEX IF NOT EXISTS matches_due ON matches(status,last_tick);
      CREATE TABLE IF NOT EXISTS members(match_id TEXT NOT NULL REFERENCES matches(id), owner TEXT NOT NULL REFERENCES accounts(id), slot INTEGER NOT NULL CHECK(slot IN(1,2)), PRIMARY KEY(match_id,owner), UNIQUE(match_id,slot));
      CREATE INDEX IF NOT EXISTS members_owner ON members(owner);
      CREATE TABLE IF NOT EXISTS receipts(owner TEXT NOT NULL REFERENCES accounts(id), command_id TEXT NOT NULL, match_id TEXT NOT NULL REFERENCES matches(id), request TEXT NOT NULL, result TEXT NOT NULL CHECK(json_valid(result)), PRIMARY KEY(owner,command_id));
      CREATE INDEX IF NOT EXISTS receipts_match ON receipts(match_id,owner);

    `);
    this.history = new SqliteEventHistory(this.db);
    // One transaction upgrades persisted v2 matches without rerolling their cable,
    // resetting energy/work or deleting immutable receipts. New grants are ledgered.
    if (version < 2) this.transaction(() => {
      for (const row of this.db.prepare('SELECT state FROM matches').all()) {
        const match = JSON.parse(row.state);
        this.upgradeLegacy(match);
        this.save(match);
      }
      this.db.exec('PRAGMA user_version=2');
    });
    // Existing saves start at an explicit cutover checkpoint, without fabricated older events.
    try { this.transaction(() => {
      for (const row of this.db.prepare('SELECT state FROM matches').all()) {
        const match = JSON.parse(row.state);
        this.history.initialize({instance_id:match.id,rule:historyRule,simulation_time_ms:match.last_advanced_ms,revision:match.revision,state:match});
      }
    }); } catch(error) { this.db.close();throw new Error('UNSUPPORTED_GAME_SAVE: restore a compatible backup or run the exact game module version that wrote this database.',{cause:error}); }
  }
  load(id) {
    const row = this.db.prepare('SELECT state FROM matches WHERE id=?').get(id);
    if (!row) gameFail('NOT_AVAILABLE');
    return JSON.parse(row.state);
  }
  save(match, source = {kind:'worker',id:'advance',principal_id:null}, action = 'advance') {
    this.assertState(match);
    this.history.initialize({instance_id:match.id,rule:historyRule,simulation_time_ms:match.last_advanced_ms,revision:match.revision,state:match});
    const previous = this.history.replay(match.id);
    this.db.prepare('UPDATE matches SET status=?,last_tick=?,state=? WHERE id=?').run(match.status, match.last_advanced_ms, JSON.stringify(match), match.id);
    if (source.kind === 'command' || canonical(previous.state) !== canonical(match)) this.history.append({
      instance_id:match.id,expected_sequence:previous.sequence,rule:historyRule,simulation_time_ms:match.last_advanced_ms,revision:match.revision,
      source,links:this.historyLinks(match,previous),provenance:{origin:'simulated',validity:'modeled',evidence:[]},
      units:[{field:'simulation_time',unit:'ms'},{field:'mass',unit:'g'},{field:'energy',unit:'mJ'}],payload:{action},state:match,
    });
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
      for (const row of rows) { const match = JSON.parse(row.state); this.advance(match); this.save(match); }
      this.db.prepare('UPDATE runtime SET heartbeat=? WHERE id=1').run(this.clock());
      this.db.prepare('DELETE FROM sessions WHERE expires<=?').run(this.clock());
    });
  }
  commandThroughCore(token, name, args) {
    let invite = null;
    try {
      return executeTransactionalCommand({command_id:args.command_id,instance_id:args.match_id,expected_revision:args.expected_revision,
        action:args.action,payload:Object.fromEntries(Object.entries(args).filter(([key])=>!['version','command_id','match_id','expected_revision','action'].includes(key)))}, {
        transaction: work => this.transaction(work), authenticate: () => this.identity(token),
        load: id => this.load(id), instanceId: state => state.id, revision: state => state.revision,
        setRevision: (state, revision) => { state.revision = revision; },
        authorized: (state, principal) => Boolean(this.member(state,principal)),
        now: state => Math.max(this.clock(),state.last_advanced_ms),
        requestKey: () => canonical({name,arguments:args}),
        receipt: (principal,id) => {
          const receipt = this.db.prepare('SELECT request,result FROM receipts WHERE owner=? AND command_id=?').get(principal,id);
          return receipt ? {request:receipt.request,result:JSON.parse(receipt.result)} : undefined;
        },
        prepare: state => {this.advance(state);return state;},
        apply: (state,command,context) => {
          this.checkMutation(state,context.principal_id,command.action);
          if(command.action==='rotate_invite'){invite=randomUUID();this.rotate(state,context.principal_id,invite);}
          else this.command(state,this.member(state,context.principal_id),{action:command.action,...command.payload});
          return {state,events:[]};
        },
        validate: state => this.assertState(state),
        result: (state,command,context) => validateGameResult(name,{version:gameContract.version,balance_version:gameContract.balance_version,
          snapshot:this.snapshot(state,context.principal_id),command_id:command.command_id,invite_code:invite}),
        save: state => this.save(state,{kind:'command',id:args.command_id,principal_id:this.identity(token)},args.action),
        saveReceipt: (principal,command,request,result) => this.db.prepare('INSERT INTO receipts VALUES(?,?,?,?,?)').run(principal,command.command_id,command.instance_id,request,JSON.stringify(result)),
      });
    } catch(error) {
      if (error instanceof SimulationCommandError) gameFail(error.code === 'EVENTS_UNSUPPORTED' ? 'INVARIANT_FAILED' : error.code);
      throw error;
    }
  }
  dispatch(token, name, raw) {
    const args = validateGameRequest(name, raw);
    if (name === 'astra.game_describe') gameFail('INVALID_REQUEST');
    if (name === 'astra.game_command') return this.commandThroughCore(token,name,args);
    return this.transaction(() => {
      const owner = this.identity(token), operation = name.replace('astra.game_', '');
      const request = canonical({ name, arguments: args });
      if (operation === 'list_matches') {
        const rows = this.db.prepare('SELECT m.state,m.created,p.slot FROM matches m JOIN members p ON p.match_id=m.id WHERE p.owner=? AND (? IS NULL OR m.id>?) ORDER BY m.id LIMIT 21').all(owner, args.cursor, args.cursor);
        const matches = rows.slice(0, 20).map(row => { const m = JSON.parse(row.state); this.advance(m); this.save(m); return { match_id: m.id, status: m.status, slot: row.slot, created_at_ms: row.created }; });
        return validateGameResult(name, { version: 3, matches, next_cursor: rows.length > 20 ? matches.at(-1).match_id : null });
      }
      if (operation !== 'read_match') {
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
        if (operation !== 'read_match') {
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
      this.save(match, operation === 'read_match' ? {kind:'worker',id:'read-advance',principal_id:null}
        : {kind:'command',id:args.command_id,principal_id:owner}, operation === 'command' ? args.action : operation);
      const result = { version: 3, balance_version: 'dump-world-v1', snapshot: this.snapshot(match, owner),
        ...(operation !== 'read_match' ? { command_id: args.command_id } : {}), ...(operation === 'command' || invite ? { invite_code: invite ?? null } : {}) };
      validateGameResult(name, result);
      if (operation !== 'read_match') this.db.prepare('INSERT INTO receipts VALUES(?,?,?,?,?)').run(owner, args.command_id, match.id, request, JSON.stringify(result));
      return result;
    });
  }

}
