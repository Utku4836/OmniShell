$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Threading;
public static class OmniConsoleGuard {
    delegate void WinEvent(IntPtr hook, uint evt, IntPtr hwnd, int obj, int child, uint thread, uint time);
    delegate bool EnumWindow(IntPtr hwnd, IntPtr data);
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    struct ProcessEntry { public uint size, usage, pid; public UIntPtr heap; public uint module, threads, parent; public int priority; public uint flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string file; }
    [StructLayout(LayoutKind.Sequential)] struct Message { public IntPtr hwnd; public uint message; public UIntPtr wp; public IntPtr lp; public uint time; public int x,y; public uint privateData; }
    [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min,uint max,IntPtr mod,WinEvent callback,uint process,uint thread,uint flags);
    [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint process);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd,StringBuilder name,int length);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd,int command);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindow callback,IntPtr data);
    [DllImport("user32.dll")] static extern int GetMessage(out Message message,IntPtr hwnd,uint min,uint max);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref Message message);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref Message message);
    [DllImport("user32.dll")] static extern bool PostThreadMessage(uint thread,uint message,UIntPtr wp,IntPtr lp);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint pid);
    [DllImport("kernel32.dll",EntryPoint="Process32FirstW")] static extern bool First(IntPtr snapshot,ref ProcessEntry entry);
    [DllImport("kernel32.dll",EntryPoint="Process32NextW")] static extern bool Next(IntPtr snapshot,ref ProcessEntry entry);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    static readonly ConcurrentDictionary<uint,byte> roots = new ConcurrentDictionary<uint,byte>();
    static bool Belongs(uint pid) {
        if (roots.ContainsKey(pid)) return true;
        var parents=new Dictionary<uint,uint>();
        IntPtr snap=CreateToolhelp32Snapshot(2,0);
        if (snap==new IntPtr(-1)) return false;
        try { var entry=new ProcessEntry(); entry.size=(uint)Marshal.SizeOf(typeof(ProcessEntry));
            if (First(snap,ref entry)) do { parents[entry.pid]=entry.parent; } while(Next(snap,ref entry));
        } finally { CloseHandle(snap); }
        for(int i=0;i<64 && pid!=0;i++) {
            if (roots.ContainsKey(pid)) return true;
            uint parent; if(!parents.TryGetValue(pid,out parent) || parent==pid) break; pid=parent;
        }
        return false;
    }
    static void Hide(IntPtr hwnd) {
        if(roots.IsEmpty || hwnd==IntPtr.Zero) return;
        var name=new StringBuilder(128); GetClassName(hwnd,name,128);
        if(name.ToString()!="ConsoleWindowClass") return;
        uint owner; GetWindowThreadProcessId(hwnd,out owner);
        if(Belongs(owner)) ShowWindow(hwnd,0);
    }
    public static void Run() {
        uint thread=GetCurrentThreadId();
        WinEvent callback=(hook,evt,hwnd,obj,child,tid,time)=> { if(obj==0 && child==0 && evt!=0x8001) Hide(hwnd); };
        IntPtr handle=SetWinEventHook(0x8000,0x8002,IntPtr.Zero,callback,0,0,2);
        if(handle==IntPtr.Zero) throw new Exception("Could not register console visibility hook");
        Console.Out.WriteLine("READY"); Console.Out.Flush();
        var input=new Thread(()=> {
            string line;
            while((line=Console.ReadLine())!=null) {
                int value; if(!Int32.TryParse(line,out value)) continue;
                if(value>0) { roots[(uint)value]=0; EnumWindows((hwnd,data)=>{ Hide(hwnd); return true; },IntPtr.Zero); }
                else { byte old; roots.TryRemove((uint)-value,out old); }
            }
            PostThreadMessage(thread,0x12,UIntPtr.Zero,IntPtr.Zero);
        });
        input.IsBackground=true; input.Start();
        try { Message msg; while(GetMessage(out msg,IntPtr.Zero,0,0)>0) { TranslateMessage(ref msg); DispatchMessage(ref msg); } }
        finally { UnhookWinEvent(handle); GC.KeepAlive(callback); }
    }
}
"@
[OmniConsoleGuard]::Run()
