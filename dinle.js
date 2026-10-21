const http = require('http')

const PORT = 3500
const SECRET = process.env.GITLAB_SECRET

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.end('Köprü çalışıyor')
    return
  }

  // GitLab'ın gönderdiği gizli anahtarı kontrol et
  if (req.headers['x-gitlab-token'] !== SECRET) {
    console.log('Yanlış anahtar, istek reddedildi')
    res.statusCode = 401
    res.end()
    return
  }

  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    res.end('ok')
    try {
      const data = JSON.parse(body)
      if (data.object_kind !== 'issue') {
        console.log('Issue olmayan olay geldi:', data.object_kind)
        return
      }
      const a = data.object_attributes
      console.log('----- GitLab issue olayı -----')
      console.log('İşlem    :', a.action)
      console.log('Proje    :', data.project.path_with_namespace)
      console.log('Numara   : #' + a.iid)
      console.log('Başlık   :', a.title)
      console.log('Açıklama :', a.description)
      console.log('Açan     :', data.user.name)
      console.log('Link     :', a.url)
    } catch (err) {
      console.log('Okunamayan istek:', err.message)
    }
  })
})

server.listen(PORT, () => console.log('Köprü GitLab\'ı dinliyor, port:', PORT))