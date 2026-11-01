/** Disposable compiled-worker smoke: bun docs/specs/profile-smoke.ts /tmp/.../polaris. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, copyFile, writeFile, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Effect } from "effect";
import { Profile, ProfileId, Timestamp } from "../../packages/protocol/src/index.ts";
import { EventStore } from "../../apps/daemon/src/store/EventStore.ts";
import { seed } from "../../apps/daemon/src/traces/authority.testing.ts";
import { TEST_SESSION } from "../../apps/daemon/src/traces/testing.ts";
import { launchDaemon, awaitReady, connect } from "../../packages/bench/src/daemon.ts";

const binary = process.argv[2];
if (binary === undefined || !binary.startsWith("/tmp/")) throw new Error("Pass a disposable /tmp compiled binary.");
const home = await mkdtemp("/tmp/p4-h-");
const workspace = await realpath(await mkdtemp("/tmp/p4-w-"));
let daemon: Awaited<ReturnType<typeof launchDaemon>> | undefined;
try {
  await mkdir(join(workspace,"package"));
  await Effect.runPromise(Effect.scoped(seed(workspace).pipe(Effect.provide(EventStore.layerSqlite(join(home,"state.sqlite"))))));
  const raw = join(home,"raw");
  await mkdir(raw);
  const child = Bun.spawn(["node","--cpu-prof",`--cpu-prof-dir=${raw}`,"-e","function profileSmoke(){let n=0;const end=Date.now()+100;while(Date.now()<end)n+=Math.sqrt(n+1);return n}profileSmoke()"],{stdout:"ignore",stderr:"ignore"});
  assert.equal(await child.exited,0);
  const name = (await readdir(raw)).find((n)=>n.endsWith(".cpuprofile"));
  assert.ok(name);
  const id = ProfileId.make(crypto.randomUUID());
  const directory = join(home,"profiles",createHash("sha256").update(workspace).digest("hex"),id);
  await mkdir(directory,{recursive:true,mode:0o700});
  await copyFile(join(raw,name),join(directory,name));
  const profile = Profile.make({id,command:"node profile-smoke",runtime:"node",pid:child.pid,turn:null,startedAt:Timestamp.make(new Date().toISOString()),durationMs:0,path:join(directory,name),status:"completed",origin:"command"});
  await writeFile(join(directory,"profile.json"),JSON.stringify(profile),{mode:0o600});
  const largeId = ProfileId.make(crypto.randomUUID());
  const largeDirectory = join(home,"profiles",createHash("sha256").update(workspace).digest("hex"),largeId);
  await mkdir(largeDirectory,{recursive:true,mode:0o700});
  const largeStart = Date.now()*1000;
  const largeRaw = JSON.stringify({ startTime:largeStart,endTime:largeStart+1_000_000,
    nodes:[{id:1,callFrame:{functionName:"(root)",url:"",lineNumber:-1},children:[2]},
      {id:2,callFrame:{functionName:"largeProfile",url:`file://${workspace}/large.js`,lineNumber:0}}],
    samples:Array(1_000_000).fill(2),timeDeltas:Array(1_000_000).fill(1),
  });
  const largeBytes = 50_000_000;
  await writeFile(join(largeDirectory,"large.cpuprofile"),largeRaw+" ".repeat(largeBytes-Buffer.byteLength(largeRaw)));
  await writeFile(join(largeDirectory,"profile.json"),JSON.stringify(Profile.make({ ...profile,id:largeId,command:"synthetic 50 MB profile",path:join(largeDirectory,"large.cpuprofile") })),{mode:0o600});
  daemon = await launchDaemon({binary,home,env:{POLARIS_TRACE_PORT:"0"}});
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        yield* awaitReady(daemon!);
    const client = yield* connect(daemon!,"socket","profile-smoke");
    assert.ok(client.capabilities.includes("traces.profiles"));
    const detail = yield* client.connection.client["profiles.get"]({sessionId:TEST_SESSION,profileId:id});
    assert.equal(detail.profile.status,"completed");
    assert.ok(detail.profile.durationMs > 0);
    assert.ok(detail.hotFunctions.some((f)=>f.name === "profileSmoke"));
    assert.ok(detail.nodes.length > 0);
    assert.equal(detail.profile.path,join(directory,name));
    console.log(JSON.stringify({binary,home,profileId:id,durationMs:detail.profile.durationMs,functions:detail.hotFunctions.length,nodes:detail.nodes.length,workerRebuiltDetail:true}));
    const latencies: number[] = [];
    let settled = false;
    const began = performance.now();
    const largeRead = Effect.runPromise(client.connection.client["profiles.get"]({sessionId:TEST_SESSION,profileId:largeId})).finally(()=>{settled=true;});
    void largeRead.catch(()=>{});
    while(!settled) {
      const requested = performance.now();
      yield* client.connection.client["files.stat"]({path:workspace});
      latencies.push(performance.now()-requested);
      yield* Effect.sleep(10);
    }
    const largeDetail = yield* Effect.promise(()=>largeRead);
    assert.equal(largeDetail.profile.status,"completed");
    assert.ok(Math.abs((largeDetail.hotFunctions.find((f)=>f.name === "largeProfile")?.selfMs ?? 0)-1000)<0.001);
    assert.ok(latencies.length>5,"independent RPCs must complete while the 50 MB profile is parsed");
    const sorted = [...latencies].sort((a,b)=>a-b);
    console.log(JSON.stringify({largeBytes,parseRoundtripMs:performance.now()-began,concurrentRpcs:latencies.length,rpcP50Ms:sorted[Math.ceil(sorted.length*.5)-1],rpcP95Ms:sorted[Math.ceil(sorted.length*.95)-1],rpcMaxMs:sorted.at(-1)}));
  })));
} finally {
  await daemon?.stop();
  await rm(home,{recursive:true,force:true});
  await rm(workspace,{recursive:true,force:true});
}
