# Query Analysis & Indexing Strategy

A comprehensive reference for every database query in the Campaign Management System, including **index usage**, **explain plan stages**, **worst-case complexity**, and **scalability notes** for 1 million+ records.

---

## 1. Index Inventory

### 1.1 `contacts` Collection

| Index Name | Fields | Type | Cardinality | Purpose |
|---|---|---|---|---|
| `_id_` | `_id: 1` | Default | Unique | Primary-key lookups |
| `phone_1` | `phone: 1` | Unique | Very High | Deduplication on insert |
| `email_1` | `email: 1` | Unique + Sparse | High | Deduplication; sparse skips null docs |
| `createdAt_-1__id_-1` | `createdAt: -1, _id: -1` | Compound | High | Cursor-based pagination (newest first) |
| `createdAt_1__id_1` | `createdAt: 1, _id: 1` | Compound | High | Cursor-based pagination (oldest first) |
| `tags_1` | `tags: 1` | Multikey | Medium | Audience filtering by tag |
| `Atlas Search Index` | `name, email, phone, tags (all autocomplete)` | Search | — | Global partial & fuzzy search |

> **Write overhead note:** 6 secondary indexes mean each `insertOne` / `insertMany` triggers 6 B-tree updates. For bulk imports this is acceptable because `insertMany({ ordered: false })` pipelines the work. Monitor `indexCounters.btreeMissRatio` in Atlas if write throughput degrades.

### 1.2 `campaigns` Collection

| Index Name | Fields | Type | Purpose |
|---|---|---|---|
| `_id_` | `_id: 1` | Default | Primary-key lookups, atomic `findOneAndUpdate` |
| `createdAt_-1__id_-1` | `createdAt: -1, _id: -1` | Compound | Campaign list pagination (newest first) |

### 1.3 `messages` Collection

| Index Name | Fields | Type | Purpose |
|---|---|---|---|
| `_id_` | `_id: 1` | Default | Bulk status updates by ID array |
| `campaignId_1_status_1` | `campaignId: 1, status: 1` | Compound | Per-campaign status breakdown |
| `status_1` | `status: 1` | Single Field | Global status dashboard / retry jobs |

> **Scale note:** At 1 M contacts × 10 campaigns = 10 M message documents. The compound index `campaignId_1_status_1` keeps per-campaign queries at O(log N) regardless of total collection size.

---

## 2. Query-by-Query Analysis

### Q1 — Contact List with Cursor Pagination

**Route:** `GET /api/contacts?cursor=&limit=20&sort=desc`

```javascript
// Controller: contactController.js → getContacts()
// Case 1: Pure Search (Lucene Path)
Contact.aggregate([
  {
    $search: {
      index: "default",
      compound: {
        must: [{ text: { query: searchTerm, path: ["name", "email", "phone"], fuzzy: {} } }],
        filter: [{ text: { query: tag, path: "tags" } }] // if tags
      }
    }
  },
  { $match: { ...cursorFilter } }, // if cursor
  { $sort: { createdAt: -1, _id: -1 } },
  { $limit: 20 }
])

// Case 2: No Search Term (B-Tree Path)
Contact.find({ 
  tags: { $in: tagsArray },
  $or: [
    { createdAt: { $lt: cursorDate } },
    { createdAt: cursorDate, _id: { $lt: cursorId } }
  ]
})
.sort({ createdAt: -1, _id: -1 })
.limit(20)
```

**Explain Plan (executionStats):**

```
IXSCAN  →  index: createdAt_-1__id_-1
  └─ FETCH  →  apply tag / regex filter in memory
       └─ LIMIT 20
```

| Metric | Value |
|---|---|
| Stage | IXSCAN → FETCH → LIMIT |
| Index used | `createdAt_-1__id_-1` |
| Documents examined | ~20–200 (bounded by cursor) |
| Sort in memory? | **No** — index provides sort order |
| Skip used? | **No** — cursor avoids `skip()` |
| Complexity | O(log N + page_size) — **constant regardless of page number** |

**Why cursor pagination beats offset at 1 M+ records:**

| Method | Page 1 | Page 50,000 |
|---|---|---|
| `skip(offset)` | Fast | Scans 1,000,000 docs, ~2–5 s |
| Cursor (`$lt`) | Fast | Fast — jumps directly via index |

**Atlas Search Optimization:** By using the `$search` operator, search queries bypass the standard MongoDB B-Tree and use a Lucene-backed inverted index. This allows for **sub-second search** even with millions of records and complex fuzzy matching (typo tolerance), which standard regex cannot handle efficiently.

---

### Q2 — Atlas Search Performance

**Explain Plan:**

```
$search  →  index: default (Lucene Inverted Index with EdgeGrams)
  └─ autocomplete (name, email, phone, tags)  →  handle global partials
  └─ $match  →  apply cursor (if present)
       └─ $sort  →  createdAt + _id
            └─ $limit 20
```

| Metric | Value |
|---|---|
| Index | `Atlas Search (default)` |
| Search Type | **Autocomplete (EdgeGram)** |
| Typo Tolerance | Enabled (Fuzzy search) |
| Min Search Chars | 2 (defined in minGrams) |

> **Scalability Note:** At 1 M+ records, Atlas Search is the industry standard. It isolates search CPU/RAM from the main database processes, ensuring that heavy search traffic doesn't slow down bulk CSV imports or campaign delivery.

---

### Q3 — CSV Bulk Import (Deduplication)

**Route:** `POST /api/contacts/upload` → CSV Processing Worker → Contact Creation Worker

```javascript
// contactCreationWorker.js
Contact.insertMany(batch, { ordered: false })
// batch size controlled by BATCH_SIZES.CONTACT_CREATION
```

**Explain Plan (per insert in batch):**

```
INSERT
  ├─ IXSCAN  →  phone_1  (unique check)
  └─ IXSCAN  →  email_1  (unique check, sparse)
```

| Metric | Value |
|---|---|
| Duplicate handling | `BulkWriteError` with `writeErrors[]` — skipped silently |
| Ordered | `false` — parallel processing, no stop-on-error |
| Index checks per row | 2 unique indexes (phone + email) |
| Throughput | ~5,000–10,000 rows/sec on a 3-node Atlas M30 |

**Batch size tuning table:**

| Batch Size | Memory per batch | Error granularity | Recommended for |
|---|---|---|---|
| 100 | ~500 KB | Fine | Low-memory envs |
| 500 | ~2.5 MB | Medium | Default |
| 1,000 | ~5 MB | Coarse | High-throughput imports |
| 5,000 | ~25 MB | Very coarse | Risk of OOM on Node.js |

---

### Q4 — Campaign Audience Streaming

**Route:** `POST /api/campaigns/:id/start` → Campaign Execution Worker

```javascript
// campaignExecutionWorker.js
const cursor = Contact.find(audienceFilter).cursor();
for await (const contact of cursor) {
  // stream to message delivery queue in batches
}
```

**Possible `audienceFilter` shapes and their index usage:**

| Filter | Index Used | Notes |
|---|---|---|
| `{}` (all contacts) | COLLSCAN | Intentional — full scan needed for "send to all". Use `.cursor()` to avoid OOM. |
| `{ tags: { $in: ['VIP'] } }` | `tags_1` (IXSCAN) | Efficient multikey index scan |
| `{ createdAt: { $gte: d1, $lte: d2 } }` | `createdAt_-1__id_-1` (IXSCAN) | Range scan on compound index |
| `{ _id: specificId }` | `_id_` (IXSCAN) | Single-document targeted delivery |
| `{ tags: [...], createdAt: {...} }` | `tags_1` OR `createdAt` index | MongoDB query planner picks best; add `hint()` if plan is wrong |

**Why `.cursor()` is critical at scale:**

```
❌ Contact.find(filter).toArray()  →  loads ALL 1M docs into Node.js heap  →  OOM crash
✅ Contact.find(filter).cursor()   →  streams docs one-by-one  →  ~50 MB heap constant
```

---

### Q5 — Campaign Start (Atomic State Transition)

```javascript
Campaign.findOneAndUpdate(
  { _id: id, status: { $in: ['Draft', 'Failed'] } },
  { $set: { status: 'Running', audienceFilter: campaignFilter } },
  { new: true }
)
```

**Explain Plan:**

```
IXSCAN  →  _id_
  └─ FETCH  →  match status filter
       └─ UPDATE in-place
```

| Metric | Value |
|---|---|
| Index | `_id_` |
| Documents examined | 1 |
| Atomicity | **Yes** — single document, MongoDB document-level locking |
| Race condition safe? | **Yes** — second concurrent request finds `status: 'Running'` and gets `null` back |

---

### Q6 — Message Bulk Status Update

**Route:** Message Delivery Worker → `updateMany`

```javascript
Message.updateMany(
  { _id: { $in: messageIds } },     // messageIds.length ≤ BATCH_SIZES.MESSAGE_DELIVERY (50)
  { $set: { status: 'Sent' } }
)

Campaign.findByIdAndUpdate(campaignId, {
  $inc: { sentCount: X, pendingCount: -X }
})
```

**Explain Plan (updateMany):**

```
IXSCAN  →  _id_  (for each ID in array)
  └─ UPDATE in-place  →  status field
```

| Metric | Value |
|---|---|
| Index | `_id_` |
| Documents examined | = batch size (max 50) |
| In-memory sort | No |
| Atomic counter update | `$inc` — no read-modify-write race |
| 10 parallel workers | Each worker touches different `messageIds` → no lock contention |

---

### Q7 — Campaign Details / Progress Polling

**Route:** `GET /api/campaigns/:id`

```javascript
Campaign.findById(id)
```

**Explain Plan:**

```
IXSCAN  →  _id_
  └─ FETCH  →  return document
```

| Metric | Value |
|---|---|
| Index | `_id_` |
| Documents examined | 1 |
| Polling frequency | Frontend polls every ~2s during active campaign |
| Counter source | Pre-computed `sentCount / failedCount / pendingCount` — **no aggregation** |

> **Why pre-computed counters?** `Message.countDocuments({ campaignId, status: 'Sent' })` at 10 M messages scans the `campaignId_1_status_1` index every 2 seconds per active campaign. With 20+ concurrent campaigns this becomes expensive. Pre-computing counters via `$inc` during delivery reduces polling cost to O(1).

---

### Q8 — Campaign List Pagination

**Route:** `GET /api/campaigns?cursor=&limit=20`

```javascript
Campaign.find({
  $or: [
    { createdAt: { $lt: cursorDate } },
    { createdAt: cursorDate, _id: { $lt: cursorId } }
  ]
})
.sort({ createdAt: -1, _id: -1 })
.limit(20)
```

**Explain Plan:**

```
IXSCAN  →  createdAt_-1__id_-1
  └─ LIMIT 20
```

| Metric | Value |
|---|---|
| Index | `createdAt_-1__id_-1` |
| In-memory sort | No |
| Documents examined | ≤ 20 |

---

## 3. Avoiding COLLSCAN — Full Reference

A **COLLSCAN** at 1 M+ records can take 2–30 seconds depending on hardware. Every production query path avoids it:

| Operation | Would cause COLLSCAN | Our solution |
|---|---|---|
| List contacts (no filter) | Yes | `createdAt` compound index + cursor pagination |
| Search contacts | Yes (regex scan) | **Atlas Search (Lucene)** with inverted index |
| Count audience | Yes (`countDocuments({})`) | `tags_1` or `createdAt` IXSCAN; for "all", use `estimatedDocumentCount()` |
| Start campaign (state check) | Yes (scan for status) | `_id_` lookup + status filter in-memory on 1 doc |
| Message status by campaign | Yes | `campaignId_1_status_1` compound index |
| Global failed message retry | Yes | `status_1` index |

---

## 4. How to Verify Query Plans

Append `.explain("executionStats")` to any Mongoose query:

```javascript
const plan = await Contact.find(query)
  .sort({ createdAt: -1, _id: -1 })
  .limit(20)
  .explain("executionStats");

console.log(JSON.stringify(plan.executionStats, null, 2));
```

**Key fields to inspect:**

| Field | Good Value | Bad Value |
|---|---|---|
| `winningPlan.stage` | `IXSCAN`, `FETCH`, `LIMIT` | `COLLSCAN` |
| `totalDocsExamined` | Close to `nReturned` | Orders of magnitude larger |
| `executionTimeMillis` | < 10ms | > 100ms |
| `indexName` | Name of expected index | `null` / missing |
| `isMultiKey` | `true` for array fields (tags) | — |

**Quick shell helper:**

```javascript
// Run in mongosh to check a specific query
db.contacts.find({ tags: { $in: ["VIP"] } })
  .sort({ createdAt: -1, _id: -1 })
  .explain("executionStats")
```

---

## 5. Scalability Thresholds & Recommendations

| Scale | Records | Recommendation |
|---|---|---|
| Current | 0 – 1 M | Current indexes sufficient |
| Near-term | 1 M – 10 M | Add `{ status: 1, createdAt: -1 }` to campaigns; shard `messages` on `campaignId` |
| Long-term | 10 M+ | Shard `contacts` on `{ _id: "hashed" }`; Use dedicated **Atlas Search Nodes** |
| Extreme | 100 M+ | Archive old campaigns to cold storage; TTL index on messages older than 90 days |

**TTL index for message cleanup (future):**

```javascript
messageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7776000 }); // 90 days
```

---

## 6. Index Creation Commands (mongosh)

Run these once on a new environment or if indexes are missing:

```javascript
// contacts
db.contacts.createIndex({ phone: 1 }, { unique: true });
db.contacts.createIndex({ email: 1 }, { unique: true, sparse: true });
db.contacts.createIndex({ createdAt: -1, _id: -1 });
db.contacts.createIndex({ createdAt: 1, _id: 1 });
db.contacts.createIndex({ tags: 1 });
db.contacts.createIndex(
  { name: "text", email: "text", phone: "text" },
  { weights: { name: 10, email: 5, phone: 3 } }
);

// campaigns
db.campaigns.createIndex({ createdAt: -1, _id: -1 });

// messages
db.messages.createIndex({ campaignId: 1, status: 1 });
db.messages.createIndex({ status: 1 });
```

Mongoose auto-creates these on startup via `autoIndex: true` (default). In production, set `autoIndex: false` and run the above manually during deployment.

---

## 7. Conclusion

| Principle | Implementation |
|---|---|
| **No unbounded `skip()`** | Cursor-based pagination on all list endpoints |
| **No COLLSCAN on hot paths** | Every filter field is indexed |
| **No in-memory sorts** | Sort order matches compound index order |
| **No OOM on large queries** | MongoDB `.cursor()` streaming for campaign audience |
| **No race conditions** | Atomic `findOneAndUpdate` for state transitions; `$inc` for counters |
| **No duplicate inserts** | Unique indexes on `phone` + sparse unique on `email` |

See [README.md](./README.md) for system architecture context.
