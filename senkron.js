// GitLab -> Huly köprüsü (yoklama yöntemi)
// Belli aralıklarla GitLab'a sorar, yeni issue'ları Huly'de oluşturur.
// Dışarıdan gelen bağlantıya (port) ihtiyaç yok, sadece içeri doğru çıkış var.

const fs = require('fs')
const path = require('path')
const { connect } = require('@hcengineering/api-client')
const core = require('@hcengineering/core').default
const { generateId, SortingOrder } = require('@hcengineering/core')
const tracker = require('@hcengineering/tracker').default
const { IssuePriority } = require('@hcengineering/tracker')
const { makeRank } = require('@hcengineering/rank')

const GITLAB_URL = (process.env.GITLAB_URL || '').replace(/\/+$/, '')
const GITLAB_TOKEN = process.env.GITLAB_TOKEN
const GITLAB_PROJECTS = (process.env.GITLAB_PROJECTS || '').split(',').map((s) => s.trim()).filter(Boolean)
const HULY_PROJECT = process.env.HULY_PROJECT
const ARALIK_MS = Number(process.env.POLL_SANIYE || 60) * 1000
const DRY_RUN = process.env.DRY_RUN === '1'
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'state.json')

function log (...args) {
  console.log(new Date().toISOString(), ...args)
}

// ---- Hangi issue'ları aktardığımızı hatırlayan dosya ----
function stateOku () {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return { projects: {} }
  }
}

function stateYaz (state) {
  fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state, null, 2))
  fs.renameSync(STATE_FILE + '.tmp', STATE_FILE)
}

// ---- GitLab tarafı ----
async function gitlabIssues (proje, createdAfter) {
  const sonuc = []
  let sayfa = 1
  while (sayfa) {
    const url = new URL(`${GITLAB_URL}/api/v4/projects/${encodeURIComponent(proje)}/issues`)
    url.searchParams.set('state', 'opened')
    url.searchParams.set('order_by', 'created_at')
    url.searchParams.set('sort', 'asc')
    url.searchParams.set('per_page', '100')
    url.searchParams.set('page', String(sayfa))
    if (createdAfter) url.searchParams.set('created_after', createdAfter)

    const res = await fetch(url, { headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN } })
    if (!res.ok) {
      throw new Error(`GitLab ${res.status} (${proje}): ${(await res.text()).slice(0, 200)}`)
    }
    sonuc.push(...(await res.json()))
    sayfa = Number(res.headers.get('x-next-page')) || 0
  }
  return sonuc
}

// ---- Huly tarafı ----
function aciklamaMetni (gl, proje) {
  const yazar = (gl.author && gl.author.name) || 'bilinmiyor'
  return `**GitLab'dan aktarıldı:** [${proje}#${gl.iid}](${gl.web_url}) · Açan: ${yazar}\n\n---\n\n${gl.description || '_(açıklama yok)_'}`
}

async function hulyIssueOlustur (client, project, gl, proje) {
  // Yeni issue numarası (örn. HULY-15)
  const inc = await client.updateDoc(tracker.class.Project, core.space.Space, project._id, { $inc: { sequence: 1 } }, true)
  const sequence = inc.object.sequence

  // Listenin sonuna eklemek için son issue'nun sırası
  const last = await client.findOne(tracker.class.Issue, { space: project._id }, { sort: { rank: SortingOrder.Descending } })

  const issueId = generateId()
  const description = await client.uploadMarkup(tracker.class.Issue, issueId, 'description', aciklamaMetni(gl, proje), 'markdown')

  await client.addCollection(tracker.class.Issue, project._id, project._id, project._class, 'issues', {
    title: gl.title,
    description,
    status: project.defaultIssueStatus,
    number: sequence,
    kind: tracker.taskTypes.Issue,
    identifier: `${project.identifier}-${sequence}`,
    priority: IssuePriority.NoPriority,
    assignee: null,
    component: null,
    estimation: 0,
    remainingTime: 0,
    reportedTime: 0,
    reports: 0,
    subIssues: 0,
    parents: [],
    childInfo: [],
    dueDate: null,
    rank: makeRank(last && last.rank, undefined)
  }, issueId)

  return `${project.identifier}-${sequence}`
}

// ---- Bir yoklama turu ----
async function tur () {
  const state = stateOku()
  const bekleyen = []

  for (const proje of GITLAB_PROJECTS) {
    const ps = (state.projects[proje] = state.projects[proje] || { lastCreated: null, synced: {} })
    let liste
    try {
      liste = await gitlabIssues(proje, ps.lastCreated)
    } catch (err) {
      log('HATA:', err.message)
      continue
    }
    for (const gl of liste) {
      if (ps.synced[gl.iid]) continue
      if (gl.confidential) {
        // Gizli issue'lar Huly'ye aktarılmaz
        ps.synced[gl.iid] = 'gizli-atlandi'
        log(`Gizli issue atlandı: ${proje}#${gl.iid}`)
        continue
      }
      bekleyen.push({ proje, gl, ps })
    }
  }

  if (DRY_RUN) {
    log(`DRY_RUN: ${bekleyen.length} issue aktarılacaktı`)
    for (const { proje, gl } of bekleyen) log(`  - ${proje}#${gl.iid}: ${gl.title}`)
    return
  }

  stateYaz(state)
  if (bekleyen.length === 0) return

  const client = await connect(process.env.HULY_URL, {
    email: process.env.HULY_EMAIL,
    password: process.env.HULY_PASSWORD,
    workspace: process.env.HULY_WORKSPACE
  })
  try {
    const project = await client.findOne(tracker.class.Project, { identifier: HULY_PROJECT })
    if (!project) throw new Error('Huly projesi bulunamadı: ' + HULY_PROJECT)

    for (const { proje, gl, ps } of bekleyen) {
      try {
        const hulyId = await hulyIssueOlustur(client, project, gl, proje)
        ps.synced[gl.iid] = hulyId
        ps.lastCreated = gl.created_at
        stateYaz(state)
        log(`Aktarıldı: ${proje}#${gl.iid} -> ${hulyId}  (${gl.title})`)
      } catch (err) {
        log(`HATA: ${proje}#${gl.iid} Huly'ye yazılamadı: ${err.message}`)
        break // sıra bozulmasın, bir sonraki turda buradan devam eder
      }
    }
  } finally {
    await client.close()
  }
}

async function main () {
  const eksik = []
  if (!GITLAB_URL) eksik.push('GITLAB_URL')
  if (!GITLAB_TOKEN) eksik.push('GITLAB_TOKEN')
  if (GITLAB_PROJECTS.length === 0) eksik.push('GITLAB_PROJECTS')
  if (!HULY_PROJECT) eksik.push('HULY_PROJECT')
  if (!DRY_RUN) {
    for (const k of ['HULY_URL', 'HULY_EMAIL', 'HULY_PASSWORD', 'HULY_WORKSPACE']) {
      if (!process.env[k]) eksik.push(k)
    }
  }
  if (eksik.length > 0) {
    console.error('HATA: .env içinde eksik satır var:', eksik.join(', '))
    process.exit(1)
  }

  process.on('SIGTERM', () => process.exit(0))
  log(`Köprü başladı. GitLab: ${GITLAB_PROJECTS.join(', ')} -> Huly: ${HULY_PROJECT}, ${ARALIK_MS / 1000} sn'de bir kontrol${DRY_RUN ? ' (DRY_RUN)' : ''}`)

  if (DRY_RUN) {
    await tur()
    return
  }
  for (;;) {
    try {
      await tur()
    } catch (err) {
      log('HATA:', err.message)
    }
    await new Promise((resolve) => setTimeout(resolve, ARALIK_MS))
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('HATA:', err.message)
    process.exit(1)
  })
}

module.exports = { tur }
