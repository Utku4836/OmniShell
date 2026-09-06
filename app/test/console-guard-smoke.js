const { spawn } = require('node:child_process')
const path = require('node:path')
const { ConsoleWindowGuard } = require('../lib/console-window-guard')
const { terminateProcessTree } = require('../lib/install-runtime')
const delay = ms => new Promise(resolve => setTimeout(resolve,ms))
const fixtureSource = `
using System; using System.Runtime.InteropServices; using System.Threading;
public static class GuardFixture {
 delegate IntPtr Proc(IntPtr h,uint m,IntPtr w,IntPtr l);
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct WC { public uint style; public IntPtr fn; public int ce,we; public IntPtr instance,icon,cursor,brush; public string menu,name; }
 [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr h; public uint m; public UIntPtr w; public IntPtr l; public uint t; public int x,y; public uint p; }
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern ushort RegisterClass(ref WC c);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr CreateWindowEx(uint ex,string cls,string title,uint style,int x,int y,int w,int h,IntPtr p,IntPtr menu,IntPtr instance,IntPtr data);
 [DllImport("user32.dll")] static extern IntPtr DefWindowProc(IntPtr h,uint m,IntPtr w,IntPtr l);
 [DllImport("user32.dll")] static extern int GetMessage(out MSG m,IntPtr h,uint a,uint b);
 [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG m);
 [DllImport("user32.dll")] static extern bool PostThreadMessage(uint id,uint msg,UIntPtr w,IntPtr l);
 [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr h);
 [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
 public static void Run() {
  Proc proc=DefWindowProc; var c=new WC(); c.fn=Marshal.GetFunctionPointerForDelegate(proc); c.instance=GetModuleHandle(null); c.name="ConsoleWindowClass";
  if(RegisterClass(ref c)==0) throw new Exception("Could not register fixture class");
  IntPtr h=CreateWindowEx(0,c.name,"OmniShell console visibility fixture",0x10CF0000,0,0,320,140,IntPtr.Zero,IntPtr.Zero,c.instance,IntPtr.Zero);
  Console.Out.WriteLine(h.ToInt64()); Console.Out.Flush();
  uint tid=GetCurrentThreadId(); var timer=new Timer(_=>PostThreadMessage(tid,0x12,UIntPtr.Zero,IntPtr.Zero),null,6000,Timeout.Infinite);
  try {MSG m; while(GetMessage(out m,IntPtr.Zero,0,0)>0) DispatchMessage(ref m);} finally {timer.Dispose(); DestroyWindow(h); GC.KeepAlive(proc);}
 }
}`
;(async()=>{
 if(process.platform!=='win32') return
 const guard=new ConsoleWindowGuard(path.resolve(__dirname,'..'))
 let fixture
 try {
  await guard.ready(); guard.watch(process.pid); await delay(100)
  const command=`Add-Type -TypeDefinition @'\n${fixtureSource}\n'@; [GuardFixture]::Run()`
  fixture=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,stdio:['ignore','pipe','pipe']})
  const handle=await new Promise((resolve,reject)=>{ let out=''; const timer=setTimeout(()=>reject(new Error('Fixture initialization timed out')),8000); fixture.stderr.on('data',d=>{clearTimeout(timer);reject(new Error(String(d)))});fixture.stdout.on('data',d=>{out+=d;const m=/\d+/.exec(out);if(m){clearTimeout(timer);resolve(m[0])}}) })
  await delay(300)
  const query=`Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class FixtureVisible { [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h); [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h); }'; $h=[IntPtr]::new(${handle}); if(-not [FixtureVisible]::IsWindow($h)){'MISSING'}elseif([FixtureVisible]::IsWindowVisible($h)){'VISIBLE'}else{'HIDDEN'}`
  const status=await new Promise((resolve,reject)=>{const p=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',query],{windowsHide:true});let out='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>out+=d);p.once('error',reject);p.once('close',()=>resolve(out.trim()))})
  if(status!=='HIDDEN') throw new Error(`Console guard fixture was not hidden: ${status}`)
  console.log('Console guard suppressed the owned console-class window')
 } finally {if(fixture) terminateProcessTree(fixture);guard.unwatch(process.pid);guard.stop()}
})().catch(error=>{console.error(error.message);process.exitCode=1})
