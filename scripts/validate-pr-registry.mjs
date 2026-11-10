import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const v = JSON.parse(readFileSync("registry/prs.json", "utf8"));
const plan = JSON.parse(
  readFileSync("docs/approved-design/development_backlog.json", "utf8"),
);
const catalog = JSON.parse(
  readFileSync("docs/approved-design/engine_catalog.json", "utf8"),
);
assert.equal(v.repository, "neophilism/Knowledge-and-verification-engine");
assert.equal(v.planVerified, true);
assert.equal(plan.tasks.length, 122);
assert.equal(catalog.engines.length, 15);
const tasks = plan.tasks.filter((t) => t.engines.includes("E07"));
assert.deepEqual(v.units.map((u) => u.legacyWorkUnitId), tasks.map((t) => t.id));
assert.equal(v.plannedPrCount, v.units.length);

const canonical = (id) => id.replaceAll(".", "-");
const indexedIds = new Set(tasks.map((task) => task.id));
for (const task of tasks) {
  const unit = v.units.find((u) => u.legacyWorkUnitId === task.id);
  assert(unit, "Missing original source task " + task.id);
  assert.equal(unit.id, canonical(task.id), "Canonical ID mapping differs from source");
  assert.deepEqual(
    unit.dependsOn,
    task.dependencies.filter((id) => indexedIds.has(id)).map(canonical),
    "Original same-repository dependencies changed"
  );
  const expectedUnresolved = task.dependencies.filter((id) => !indexedIds.has(id))
    .map((id) => "Required original cross-project milestone " + id +
      " is not yet mapped to a verified upstream repo/unit; block this unit until source evidence is linked");
  for (const prerequisite of expectedUnresolved) {
    assert(unit.externalPrerequisites.includes(prerequisite),
      "Missing original cross-project dependency hold for " + task.id);
  }
  assert.deepEqual(unit.externalDependencies, [],
    "External dependency must not claim a verified upstream mapping until evidence exists");
  assert.deepEqual(unit.prs, [], "Do not fabricate completed PR evidence");
}
for (const u of v.units) assert(u.implementationStatus);
console.log(
  "Valid Knowledge registry:15 engines/122 original tasks; owning E07 task IDs/dependencies preserved; implementation partial",
);

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const evidencePin = "d240403c39934ab781178efea8cf4922c94d88a4";
assert.equal(
  pkg.dependencies["@accountability/evidence"],
  "git+https://github.com/Justice-For-All-Movement/Evidence-Storage-and-Provenance-Engine.git#" +
    evidencePin,
);
assert(
  lock.packages["node_modules/@accountability/evidence"].resolved.endsWith(
    "#" + evidencePin,
  ),
);
console.log(
  "Evidence domain SDK pinned; persistence uses a separate stable pin",
);
const persistencePin = "dce7105a70b42d77afe4cd48d34723331447037c";
assert.equal(
  pkg.dependencies["@accountability/evidence-sql"],
  "git+https://github.com/Justice-For-All-Movement/Evidence-Storage-and-Provenance-Engine.git#" +
    persistencePin,
);
assert(
  lock.packages["node_modules/@accountability/evidence-sql"].resolved.endsWith(
    "#" + persistencePin,
  ),
);
console.log("Separate stable persistence SDK pinned for Knowledge owning DB");
assert.equal(pkg.dependencies["@accountability/identity-policy"],"git+https://github.com/Justice-For-All-Movement/Identity-Authorization-and-Policy-Engine.git#763060ddc840979b56483afd830f78679a2369b0");
assert(lock.packages["node_modules/@accountability/identity-policy"].resolved.endsWith("#763060ddc840979b56483afd830f78679a2369b0"));
console.log("Accepted Identity resource policy SDK pinned");

const consentPin = "cd4d35e3247aacae96c0dae7ba416125f73dc383";
assert.equal(pkg.dependencies["@accountability/consent-rights"],
  "git+https://github.com/Justice-For-All-Movement/Consent-rights-and-use-decisions-engine.git#" + consentPin);
assert(lock.packages["node_modules/@accountability/consent-rights"].resolved.endsWith("#" + consentPin));
console.log("Accepted current-time Consent SDK pinned separately from Evidence persistence");
