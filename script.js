/* =====================================================================
   PART 1 – A small MongoDB shell engine written in plain JavaScript.
   It understands the same commands you type in mongosh (use, show dbs,
   db.students.find(...), updateOne, deleteMany, sort, limit ...).
   Data lives in memory only, so nothing is saved after you refresh.
   ===================================================================== */
class ObjectId {
  constructor() { this.hex = Array.from({ length: 24 }, () => Math.floor(Math.random() * 16).toString(16)).join(""); }
  toString() { return this.hex; }
}
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof ObjectId) && !(v instanceof Date);
const clone = (v) => v instanceof ObjectId ? v : v instanceof Date ? new Date(v) : Array.isArray(v) ? v.map(clone)
  : isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)])) : v;
const getVal = (doc, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), doc);

/* ----- query matching: $gt, $lt, $gte, $lte, $in, $nin, $ne, $eq, $exists, $and, $or ----- */
function eq(a, b) {
  if (a instanceof ObjectId || b instanceof ObjectId) return String(a) === String(b);
  if (Array.isArray(a) && !Array.isArray(b)) return a.some((x) => eq(x, b));
  if (a && b && typeof a === "object" && typeof b === "object") return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}
function compare(op, v, x) {
  const same = typeof v === typeof x;
  switch (op) {
    case "$gt": return same && v > x;
    case "$gte": return same && v >= x;
    case "$lt": return same && v < x;
    case "$lte": return same && v <= x;
    case "$eq": return eq(v, x);
    case "$ne": return !eq(v, x);
    case "$in": return x.some((y) => eq(v, y));
    case "$nin": return !x.some((y) => eq(v, y));
    case "$exists": return (v !== undefined) === x;
    default: throw new Error("MongoServerError: unknown operator: " + op);
  }
}
function match(doc, q) {
  return Object.keys(q).every((k) => {
    if (k === "$and") return q[k].every((s) => match(doc, s));
    if (k === "$or") return q[k].some((s) => match(doc, s));
    const v = getVal(doc, k), c = q[k];
    if (isObj(c) && Object.keys(c).some((o) => o[0] === "$")) return Object.keys(c).every((op) => compare(op, v, c[op]));
    return eq(v, c);
  });
}
function project(doc, p) {
  const keys = Object.keys(p).filter((k) => k !== "_id");
  const include = keys.some((k) => p[k]);
  const out = {};
  if (p._id !== 0 && "_id" in doc) out._id = doc._id;
  Object.keys(doc).forEach((k) => { if (k !== "_id" && (include ? p[k] : p[k] !== 0)) out[k] = doc[k]; });
  return out;
}
function applyUpdate(doc, u) {                       // $set, $inc, $mul, $unset
  if (!Object.keys(u).every((k) => k[0] === "$")) throw new Error("MongoServerError: Update document requires atomic operators like $set");
  for (const [op, fields] of Object.entries(u)) {
    for (const [f, val] of Object.entries(fields)) {
      if (op === "$set") doc[f] = val;
      else if (op === "$inc") doc[f] = (doc[f] || 0) + val;
      else if (op === "$mul") doc[f] = (doc[f] || 0) * val;
      else if (op === "$unset") delete doc[f];
      else throw new Error("MongoServerError: unsupported update operator " + op);
    }
  }
}

/* ----- cursor: sort(), limit(), skip(), pretty(), toArray(), count() ----- */
class Cursor {
  constructor(docs) { this.docs = docs; }
  sort(spec) {
    const keys = Object.keys(spec);
    this.docs = [...this.docs].sort((a, b) => {
      for (const k of keys) {
        const x = getVal(a, k), y = getVal(b, k);
        if (x === y) continue;
        return ((x === undefined || x < y) ? -1 : 1) * spec[k];
      }
      return 0;
    });
    return this;
  }
  limit(n) { this.docs = this.docs.slice(0, n); return this; }
  skip(n) { this.docs = this.docs.slice(n); return this; }
  pretty() { return this; }
  toArray() { return this.docs; }
  count() { return this.docs.length; }
}

/* ----- a collection: insert / find / update / delete / count ----- */
class Collection {
  constructor(engine, dbName, name) { this.e = engine; this.dbName = dbName; this.name = name; }
  get arr() { return (this.e.dbs[this.dbName] || {})[this.name] || []; }
  ensure() { const d = (this.e.dbs[this.dbName] = this.e.dbs[this.dbName] || {}); return (d[this.name] = d[this.name] || []); }
  insertOne(doc) {
    if (!isObj(doc)) throw new Error("MongoInvalidArgumentError: document must be an object");
    const d = clone(doc); const full = "_id" in d ? d : { _id: new ObjectId(), ...d };
    this.ensure().push(full);
    return { acknowledged: true, insertedId: full._id };
  }
  insertMany(list) {
    if (!Array.isArray(list)) throw new Error("MongoInvalidArgumentError: insertMany needs an array of documents");
    const ids = {}; list.forEach((d, i) => { ids[i] = this.insertOne(d).insertedId; });
    return { acknowledged: true, insertedIds: ids };
  }
  find(q = {}, p) { const r = this.arr.filter((d) => match(d, q)); return new Cursor(p ? r.map((d) => project(d, p)) : r); }
  findOne(q = {}, p) { const r = this.find(q, p).toArray()[0]; return r === undefined ? null : r; }
  _update(q, u, many) {
    const hits = this.arr.filter((d) => match(d, q)).slice(0, many ? Infinity : 1);
    let modified = 0;
    hits.forEach((d) => { const before = JSON.stringify(d); applyUpdate(d, u); if (JSON.stringify(d) !== before) modified++; });
    return { acknowledged: true, insertedId: null, matchedCount: hits.length, modifiedCount: modified, upsertedCount: 0 };
  }
  updateOne(q, u) { return this._update(q, u, false); }
  updateMany(q, u) { return this._update(q, u, true); }
  _delete(q, many) {
    const arr = this.arr; let n = 0;
    for (let i = 0; i < arr.length; ) { if (match(arr[i], q) && (many || n === 0)) { arr.splice(i, 1); n++; } else i++; }
    return { acknowledged: true, deletedCount: n };
  }
  deleteOne(q) { return this._delete(q, false); }
  deleteMany(q) { return this._delete(q, true); }
  countDocuments(q = {}) { return this.arr.filter((d) => match(d, q)).length; }
  drop() { delete (this.e.dbs[this.dbName] || {})[this.name]; return true; }
}

/* ----- pretty printer that looks like mongosh output ----- */
function fmt(v, ind = 0) {
  const pad = "  ".repeat(ind), pad1 = "  ".repeat(ind + 1);
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (v instanceof ObjectId) return `ObjectId('${v}')`;
  if (v instanceof Date) return `ISODate('${v.toISOString()}')`;
  if (typeof v === "string") return `'${v.replace(/'/g, "\\'")}'`;
  if (typeof v !== "object") return String(v);
  const simple = (x) => x === null || typeof x !== "object" || x instanceof ObjectId || x instanceof Date;
  if (Array.isArray(v)) {
    if (!v.length) return "[]";
    if (v.every(simple)) { const s = "[ " + v.map((x) => fmt(x)).join(", ") + " ]"; if (s.length <= 72) return s; }
    return "[\n" + v.map((x) => pad1 + fmt(x, ind + 1)).join(",\n") + "\n" + pad + "]";
  }
  const entries = Object.entries(v);
  if (!entries.length) return "{}";
  const key = (k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : `'${k}'`);
  if (entries.every(([, x]) => simple(x))) {
    const s = "{ " + entries.map(([k, x]) => key(k) + ": " + fmt(x)).join(", ") + " }";
    if (s.length <= 72) return s;
  }
  return "{\n" + entries.map(([k, x]) => pad1 + key(k) + ": " + fmt(x, ind + 1)).join(",\n") + "\n" + pad + "}";
}

/* ----- statement splitter: lets you paste multi-line commands ----- */
function bracketDelta(s) {
  let d = 0, q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === "\\") i++; else if (c === q) q = null; }
    else if (c === '"' || c === "'" || c === "`") q = c;
    else if ("([{".includes(c)) d++;
    else if (")]}".includes(c)) d--;
  }
  return d;
}
function splitStatements(text) {
  const out = []; let buf = "", depth = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (depth === 0 && (line === "" || line.startsWith("//"))) { if (buf) { out.push(buf); buf = ""; } continue; }
    if (depth === 0 && buf && !line.startsWith(".")) { out.push(buf); buf = ""; }
    buf += (buf ? "\n" : "") + raw;
    depth += bracketDelta(raw);
  }
  if (buf.trim()) out.push(buf);
  return out;
}

/* ----- the engine: keeps databases, the current db, and runs statements ----- */
class Engine {
  constructor() { this.reset(); }
  reset() { this.dbs = {}; this.current = "test"; }
  dropDatabase(name) { delete this.dbs[name]; }
  get db() {
    const e = this;
    return new Proxy({}, {
      get(_, prop) {
        if (typeof prop !== "string") return undefined;
        if (prop === "createCollection") return (n) => {
          const d = (e.dbs[e.current] = e.dbs[e.current] || {});
          if (d[n]) throw new Error(`MongoServerError[NamespaceExists]: Collection ${e.current}.${n} already exists.`);
          d[n] = []; return { ok: 1 };
        };
        if (prop === "getCollectionNames") return () => Object.keys(e.dbs[e.current] || {});
        if (prop === "dropDatabase") return () => { e.dropDatabase(e.current); return { ok: 1, dropped: e.current }; };
        if (prop === "getName") return () => e.current;
        if (prop === "stats") return () => {
          const d = e.dbs[e.current] || {}, all = Object.values(d).flat(), bytes = JSON.stringify(all).length;
          return { db: e.current, collections: Object.keys(d).length, views: 0, objects: all.length,
            avgObjSize: all.length ? Math.round(bytes / all.length) : 0, dataSize: bytes, indexes: Object.keys(d).length, ok: 1 };
        };
        return new Collection(e, e.current, prop);
      },
    });
  }
  size(name) { return (8 * Math.max(1, Math.ceil(JSON.stringify(this.dbs[name] || {}).length / 1024))).toFixed(2) + " KiB"; }
  exec(t) {                                           // run ONE statement, return text
    let m;
    if ((m = t.match(/^use\s+(\S+)$/))) { this.current = m[1]; return "switched to db " + m[1]; }
    if (/^show\s+(dbs|databases)$/.test(t)) {
      const rows = [["admin", "40.00 KiB"], ["config", "12.00 KiB"], ["local", "40.00 KiB"]];
      Object.keys(this.dbs).filter((n) => Object.values(this.dbs[n]).some((c) => c.length)).forEach((n) => rows.push([n, this.size(n)]));
      const w = Math.max(...rows.map((r) => r[0].length)) + 2;
      return rows.map((r) => r[0].padEnd(w) + r[1]).join("\n");
    }
    if (/^show\s+(collections|tables)$/.test(t)) return Object.keys(this.dbs[this.current] || {}).join("\n");
    if (t === "db") return this.current;
    if (t === "help") return "Try: use CollegeDB · show dbs · show collections · db.students.find() · db.students.insertOne({...})\nSupported: insertOne/Many, find, findOne, updateOne/Many, deleteOne/Many, countDocuments, sort, limit, skip";
    if (/^(var|let|const)\s/.test(t)) throw new Error("This simulator runs single commands. Remove var/let/const and run the command directly.");
    const result = new Function("db", "ObjectId", "ISODate", "return (" + t + "\n)")(this.db, ObjectId, (s) => (s ? new Date(s) : new Date()));
    if (result instanceof Cursor) return result.docs.length ? fmt(result.docs) : "";
    return fmt(result);
  }
  run(text) {                                         // returns lines to print: {cls, text}
    const lines = [];
    for (const st of splitStatements(text)) {
      lines.push({ cls: "cmd", text: this.current + "> " + st });
      try {
        const out = this.exec(st.trim().replace(/;$/, ""));
        if (out !== "" && out !== undefined) lines.push({ cls: "out", text: out });
      } catch (err) { lines.push({ cls: "err", text: String(err.message || err) }); }
    }
    return lines;
  }
}

/* =====================================================================
   PART 2 – Practical sheet commands (Steps 1-11 and Questions 1-5)
   ===================================================================== */
const STUDENTS = `db.students.insertMany([
  { rollNo: 101, name: "Arun", department: "CSE", age: 20, mark: 85 },
  { rollNo: 102, name: "Priya", department: "IT", age: 21, mark: 92 },
  { rollNo: 103, name: "Kumar", department: "CSE", age: 19, mark: 78 },
  { rollNo: 104, name: "Divya", department: "ECE", age: 20, mark: 88 },
  { rollNo: 105, name: "Ravi", department: "CSE", age: 22, mark: 67 }
])`;
const LESSONS = [
  { id: "steps", title: "Sample Steps 1–11", db: "CollegeDB", items: [
    ["Step 2 · Show current database", "db"],
    ["Step 3 · Create a collection", 'db.createCollection("students")'],
    ["Step 3 · Show collections", "show collections"],
    ["Step 4 · insertOne", 'db.students.insertOne({ rollNo: 101, name: "Arun", department: "CSE", age: 20, mark: 85 })'],
    ["Step 4 · insertMany", `db.students.insertMany([
  { rollNo: 102, name: "Priya", department: "IT", age: 21, mark: 92 },
  { rollNo: 103, name: "Kumar", department: "CSE", age: 19, mark: 78 },
  { rollNo: 104, name: "Divya", department: "ECE", age: 20, mark: 88 },
  { rollNo: 105, name: "Ravi", department: "CSE", age: 22, mark: 67 }
])`],
    ["Step 5 · Display all records", "db.students.find().pretty()"],
    ["Step 5 · Find by name", 'db.students.find({ name: "Priya" })'],
    ["Step 5 · findOne from CSE", 'db.students.findOne({ department: "CSE" })'],
    ["Step 6 · Marks greater than 80", "db.students.find({ mark: { $gt: 80 } })"],
    ["Step 6 · Age between 20 and 21", "db.students.find({ age: { $gte: 20, $lte: 21 } })"],
    ["Step 6 · CSE or IT", 'db.students.find({ department: { $in: ["CSE", "IT"] } })'],
    ["Step 6 · Marks less than 80", "db.students.find({ mark: { $lt: 80 } })"],
    ["Step 7 · Update Arun's marks", "db.students.updateOne({ rollNo: 101 }, { $set: { mark: 90 } })"],
    ["Step 7 · +5 marks for all CSE", 'db.students.updateMany({ department: "CSE" }, { $inc: { mark: 5 } })'],
    ["Step 7 · Verify updates", "db.students.find()"],
    ["Step 8 · deleteOne (roll 105)", "db.students.deleteOne({ rollNo: 105 })"],
    ["Step 8 · deleteMany (marks below 70)", "db.students.deleteMany({ mark: { $lt: 70 } })"],
    ["Step 9 · Sort by marks (high to low)", "db.students.find().sort({ mark: -1 })"],
    ["Step 9 · Top three students", "db.students.find().sort({ mark: -1 }).limit(3)"],
    ["Step 10 · Count all students", "db.students.countDocuments()"],
    ["Step 10 · Count CSE students", 'db.students.countDocuments({ department: "CSE" })'],
    ["Step 11 · Show databases", "show dbs"],
    ["Step 11 · Database statistics", "db.stats()"],
  ]},
  { id: "q1", title: "Q1 · Student Database Management", db: "CollegeDB", items: [
    ["Create DB + insert 5 students", STUDENTS],
    ["a. Display all student records", "db.students.find()"],
    ["b. Find a student by roll number", "db.students.find({ rollNo: 103 })"],
    ["c. Students who scored more than 80", "db.students.find({ mark: { $gt: 80 } })"],
    ["d. Update marks of a student", "db.students.updateOne({ rollNo: 104 }, { $set: { mark: 95 } })"],
    ["e. Delete a student by roll number", "db.students.deleteOne({ rollNo: 105 })"],
  ]},
  { id: "q2", title: "Q2 · Employee Database", db: "EmployeeDB", items: [
    ["Create DB + insert 5 employees", `db.employees.insertMany([
  { empId: 1, name: "Anand", department: "IT", salary: 52000, experience: 4 },
  { empId: 2, name: "Meena", department: "HR", salary: 38000, experience: 3 },
  { empId: 3, name: "Suresh", department: "IT", salary: 61000, experience: 7 },
  { empId: 4, name: "Lakshmi", department: "Finance", salary: 45000, experience: 5 },
  { empId: 5, name: "Karthik", department: "HR", salary: 35000, experience: 2 }
])`],
    ["a. Display all employees", "db.employees.find()"],
    ["b. Earning more than ₹40,000", "db.employees.find({ salary: { $gt: 40000 } })"],
    ["c. Update an employee's salary", "db.employees.updateOne({ empId: 2 }, { $set: { salary: 42000 } })"],
    ["d. Descending order of salary", "db.employees.find().sort({ salary: -1 })"],
    ["e. Count employees in a department", 'db.employees.countDocuments({ department: "IT" })'],
  ]},
  { id: "q3", title: "Q3 · Product Database", db: "ProductDB", items: [
    ["Create DB + insert products", `db.products.insertMany([
  { productId: 1, name: "Keyboard", category: "Electronics", price: 1200, stock: 25 },
  { productId: 2, name: "Mouse", category: "Electronics", price: 600, stock: 40 },
  { productId: 3, name: "Notebook", category: "Stationery", price: 80, stock: 0 },
  { productId: 4, name: "Backpack", category: "Accessories", price: 1800, stock: 12 },
  { productId: 5, name: "Headphones", category: "Electronics", price: 2500, stock: 0 },
  { productId: 6, name: "Water Bottle", category: "Accessories", price: 450, stock: 30 }
])`],
    ["a. Products of a category", 'db.products.find({ category: "Electronics" })'],
    ["b. Priced between ₹500 and ₹2,000", "db.products.find({ price: { $gte: 500, $lte: 2000 } })"],
    ["c. Increase stock of a product", "db.products.updateOne({ productId: 1 }, { $inc: { stock: 10 } })"],
    ["d. Delete products with zero stock", "db.products.deleteMany({ stock: 0 })"],
    ["e. Five most expensive products", "db.products.find().sort({ price: -1 }).limit(5)"],
  ]},
  { id: "q4", title: "Q4 · Library Database", db: "LibraryDB", items: [
    ["Create DB + insert books", `db.books.insertMany([
  { bookId: 1, title: "Wings of Fire", author: "A. P. J. Abdul Kalam", category: "Biography", price: 250 },
  { bookId: 2, title: "Ignited Minds", author: "A. P. J. Abdul Kalam", category: "Inspiration", price: 220 },
  { bookId: 3, title: "Clean Code", author: "Robert C. Martin", category: "Technology", price: 900 },
  { bookId: 4, title: "The Pragmatic Programmer", author: "Andrew Hunt", category: "Technology", price: 850 },
  { bookId: 5, title: "Godan", author: "Premchand", category: "Novel", price: 180 }
])`],
    ["a. Books by an author", 'db.books.find({ author: "A. P. J. Abdul Kalam" })'],
    ["b. Books in a category", 'db.books.find({ category: "Technology" })'],
    ["c. Update the price of a book", 'db.books.updateOne({ title: "Godan" }, { $set: { price: 200 } })'],
    ["d. Sort alphabetically by title", "db.books.find().sort({ title: 1 })"],
    ["e. Count books", "db.books.countDocuments()"],
  ]},
  { id: "q5", title: "Q5 · Query Operations (students)", db: "CollegeDB", items: [
    ["Insert sample students", STUDENTS],
    ["a. Marks greater than or equal to 75", "db.students.find({ mark: { $gte: 75 } })"],
    ["b. Age less than 21", "db.students.find({ age: { $lt: 21 } })"],
    ["c. Either CSE or IT", 'db.students.find({ department: { $in: ["CSE", "IT"] } })'],
    ["d. Top three students by marks", "db.students.find().sort({ mark: -1 }).limit(3)"],
    ["e. updateMany – bonus 2 marks to all ECE and IT", 'db.students.updateMany({ department: { $in: ["ECE", "IT"] } }, { $inc: { mark: 2 } })'],
  ]},
];

if (typeof module !== "undefined") module.exports = { Engine, LESSONS };

/* =====================================================================
   PART 3 – Page behaviour (runs only inside the browser)
   ===================================================================== */
if (typeof document !== "undefined") {
  const $ = (id) => document.getElementById(id);
  const engine = new Engine();

  /* ---- terminal ---- */
  function print(lines) {
    lines.forEach((l) => {
      const div = document.createElement("div");
      div.className = "line " + l.cls; div.textContent = l.text;
      $("term").appendChild(div);
    });
    $("term").scrollTop = $("term").scrollHeight;
    $("prompt").textContent = engine.current + ">";
  }
  const say = (text) => print([{ cls: "info", text }]);
  function runText(text) { print(engine.run(text)); }
  function runLesson(lesson, i) { runText("use " + lesson.db + "\n" + lesson.items[i][1]); }

  $("runBtn").addEventListener("click", () => { if ($("editor").value.trim()) runText($("editor").value); });
  $("editor").addEventListener("keydown", (e) => { if (e.ctrlKey && e.key === "Enter") $("runBtn").click(); });
  $("clearBtn").addEventListener("click", () => { $("term").innerHTML = ""; });
  $("resetBtn").addEventListener("click", () => { engine.reset(); $("term").innerHTML = ""; say("All databases cleared. You are in db 'test' again."); });

  /* ---- build the lesson cards from LESSONS ---- */
  const holder = $("lessons");
  LESSONS.forEach((lesson, li) => {
    const box = document.createElement("details");
    box.className = "glass lesson"; if (li === 0) box.open = true;
    box.innerHTML = `<summary><span>${lesson.title}</span><em>${lesson.db}</em></summary>
      <div class="lesson-actions"><button class="btn small primary" data-all>▶ Run all in order (fresh database)</button></div>`;
    lesson.items.forEach((item, i) => {
      const row = document.createElement("div");
      row.className = "cmd-row";
      row.innerHTML = `<div class="cmd-label">${item[0]}</div><pre></pre>
        <div class="cmd-btns"><button class="btn small" data-run>Run</button><button class="btn small" data-edit>Edit</button></div>`;
      row.querySelector("pre").textContent = item[1];
      row.querySelector("[data-run]").addEventListener("click", () => runLesson(lesson, i));
      row.querySelector("[data-edit]").addEventListener("click", () => { $("editor").value = item[1]; $("editor").focus(); });
      box.appendChild(row);
    });
    box.querySelector("[data-all]").addEventListener("click", () => {
      engine.dropDatabase(lesson.db);
      say("// Fresh start: " + lesson.title);
      lesson.items.forEach((_, i) => runLesson(lesson, i));
    });
    holder.appendChild(box);
  });
  say("MongoDB Shell simulator ready. Type a command or press Run on any card. Try: use CollegeDB");

  /* ---- navbar, typing effect (setTimeout), clock (setInterval) ---- */
  const phrases = ["Aspiring Software Developer", "MongoDB Learner", "Creator of E-DOUSE"];
  let p = 0, c = 0, del = false;
  (function type() {
    const t = phrases[p]; c += del ? -1 : 1;
    $("typed").textContent = t.slice(0, c);
    let d = del ? 40 : 90;
    if (!del && c === t.length) { del = true; d = 1400; }
    else if (del && c === 0) { del = false; p = (p + 1) % phrases.length; d = 400; }
    setTimeout(type, d);
  })();
  setInterval(() => { $("clock").textContent = new Date().toLocaleTimeString(); }, 1000);
  $("clock").textContent = new Date().toLocaleTimeString();
  $("menuBtn").addEventListener("click", () => $("navLinks").classList.toggle("open"));
  document.querySelectorAll(".nav-links a").forEach((a) => a.addEventListener("click", () => $("navLinks").classList.remove("open")));
  window.addEventListener("scroll", () => $("navbar").classList.toggle("scrolled", window.scrollY > 40));

  /* ---- scroll reveal + skill bars ---- */
  const io = new IntersectionObserver((entries) => entries.forEach((en) => {
    if (!en.isIntersecting) return;
    en.target.classList.add("visible");
    en.target.querySelectorAll(".bar i").forEach((b) => (b.style.width = b.dataset.level + "%"));
    io.unobserve(en.target);
  }), { threshold: 0.15 });
  document.querySelectorAll(".reveal").forEach((el) => io.observe(el));

  /* ---- contact form validation ---- */
  const setErr = (id, m) => { $(id + "Err").textContent = m; return !m; };
  const checks = {
    name: () => { const v = $("name").value.trim(); return setErr("name", !v ? "Name is required." : v.length > 8 ? "Maximum 8 characters." : !/^[A-Za-z ]+$/.test(v) ? "Letters and spaces only." : ""); },
    email: () => setErr("email", /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test($("email").value.trim()) ? "" : "Enter a valid email address."),
    phone: () => setErr("phone", /^[6-9]\d{9}$/.test($("phone").value.trim()) ? "" : "Phone must be 10 digits starting with 6-9."),
    message: () => setErr("message", $("message").value.trim() ? "" : "Message cannot be empty."),
  };
  Object.keys(checks).forEach((k) => $(k).addEventListener("input", checks[k]));
  $("contactForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const ok = Object.values(checks).map((f) => f()).every(Boolean);
    $("formSuccess").textContent = ok ? "Thank you! Details are valid. (Demo only: sending needs a backend.)" : "";
    if (ok) e.target.reset();
  });
}
