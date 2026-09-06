const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const zlib = require('node:zlib')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { createInstallPlan, createInstallEnvironment, profileRuntimeDir } = require('../lib/tooling')
const { installedVersion } = require('../lib/tool-updates')

function tarball(version) {
  const files = {
    'package/package.json': JSON.stringify({name:'omnishell-update-fixture',version,bin:{fixture:'bin.js'}}),
    'package/bin.js': `#!/usr/bin/env node\nconsole.log('${version}')\n`
  }
  const blocks=[]
  for(const [name,text] of Object.entries(files)) {
    const content=Buffer.from(text),header=Buffer.alloc(512)
    header.write(name,0,100)
    header.write('0000755\0',100,8);header.write('0000000\0',108,8);header.write('0000000\0',116,8)
    header.write(content.length.toString(8).padStart(11,'0')+'\0',124,12)
    header.write('00000000000\0',136,12);header.fill(32,148,156);header.write('0',156,1);header.write('ustar\0',257,6);header.write('00',263,2)
    const sum=header.reduce((value,byte)=>value+byte,0)
    header.write(sum.toString(8).padStart(6,'0')+'\0 ',148,8)
    blocks.push(header,content,Buffer.alloc((512-content.length%512)%512))
  }
  return zlib.gzipSync(Buffer.concat([...blocks,Buffer.alloc(1024)]))
}

test('the real npm installer upgrades a pinned package using a local registry', {timeout:120000}, async (t) => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'omnishell-npm-update-'))
  const packages=Object.fromEntries(['1.0.0','2.0.0'].map(version=>[version,tarball(version)]))
  const server=http.createServer((request,response)=>{
    const version=/([12]\.0\.0)\.tgz/.exec(request.url)?.[1]
    if(version){response.setHeader('Content-Type','application/octet-stream');response.end(packages[version]);return}
    const base=`http://127.0.0.1:${server.address().port}`
    response.setHeader('Content-Type','application/json')
    response.end(JSON.stringify({name:'omnishell-update-fixture','dist-tags':{latest:'2.0.0'},versions:Object.fromEntries(Object.entries(packages).map(([version,bytes])=>[version,{
      name:'omnishell-update-fixture',version,bin:{fixture:'bin.js'},dist:{tarball:`${base}/fixture-${version}.tgz`,integrity:`sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`}
    }]))}))
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:100})})
  const tool={id:'fixture',dir:'Fixture',bin:'fixture',name:'Fixture',installer:{type:'npm',package:'omnishell-update-fixture'}}
  async function install(version) {
    const plan=createInstallPlan(tool,path.resolve(__dirname,'..'),root,'default',version)
    const env=createInstallEnvironment(tool,process.env,root)
    Object.assign(env,{npm_config_registry:`http://127.0.0.1:${server.address().port}`,npm_config_proxy:'',npm_config_https_proxy:'',npm_config_noproxy:'127.0.0.1'})
    const result=await new Promise((resolve,reject)=>{
      const child=spawn(plan.command,plan.args,{cwd:plan.cwd,env,windowsHide:true})
      let output=''
      child.stdout.on('data',data=>{output=(output+data).slice(-8000)})
      child.stderr.on('data',data=>{output=(output+data).slice(-8000)})
      child.on('error',reject);child.on('close',code=>resolve({code,output}))
    })
    assert.equal(result.code,0,result.output)
    return installedVersion(tool,root)
  }
  assert.equal(await install('1.0.0'),'1.0.0')
  const manifest=JSON.parse(await fs.readFile(path.join(profileRuntimeDir(tool,'default',root),'package.json'),'utf8'))
  assert.equal(manifest.dependencies['omnishell-update-fixture'],'1.0.0')
  assert.equal(await install('2.0.0'),'2.0.0')
})
