const { connect } = require('@hcengineering/api-client')
const core = require('@hcengineering/core').default
const { generateId, SortingOrder } = require('@hcengineering/core')
const tracker = require('@hcengineering/tracker').default
const { IssuePriority } = require('@hcengineering/tracker')
const { makeRank } = require('@hcengineering/rank')

const PROJE = process.argv[2]

async function main () {
  if (!PROJE) throw new Error('Proje kodunu yazmadın. Örnek: node issue.js TSK')

  const client = await connect(process.env.HULY_URL, {
    email: process.env.HULY_EMAIL,
    password: process.env.HULY_PASSWORD,
    workspace: process.env.HULY_WORKSPACE
  })

  try {
    // 1. Projeyi bul
    const project = await client.findOne(tracker.class.Project, { identifier: PROJE })
    if (!project) throw new Error('Proje bulunamadı: ' + PROJE)

    // 2. Yeni issue numarasını al (örn. TSK-15)
    const inc = await client.updateDoc(tracker.class.Project, core.space.Space, project._id, { $inc: { sequence: 1 } }, true)
    const sequence = inc.object.sequence

    // 3. Listede en sona eklemek için son issue'yu bul
    const last = await client.findOne(tracker.class.Issue, { space: project._id }, { sort: { rank: SortingOrder.Descending } })

    // 4. Açıklamayı yükle
    const issueId = generateId()
    const description = await client.uploadMarkup(tracker.class.Issue, issueId, 'description',
      'Bu issue **köprü programı** tarafından test amaçlı oluşturuldu. Silebilirsiniz.', 'markdown')

    // 5. Issue'yu oluştur
    await client.addCollection(tracker.class.Issue, project._id, project._id, project._class, 'issues', {
      title: '[TEST] Köprü test issue',
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
      rank: makeRank(last?.rank, undefined)
    }, issueId)

    console.log('Issue oluşturuldu:', `${project.identifier}-${sequence}`)
  } finally {
    await client.close()
  }
}

main().catch((err) => {
  console.error('HATA:', err.message)
  process.exit(1)
})