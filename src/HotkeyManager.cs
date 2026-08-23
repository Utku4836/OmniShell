using System;
using System.Runtime.InteropServices;
using System.Windows.Interop;

namespace SiyahUygulama
{
    public class HotkeyManager : IDisposable
    {
        [DllImport("user32.dll")]
        private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

        [DllImport("user32.dll")]
        private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

        public const uint ModAlt = 0x0001;
        public const uint ModControl = 0x0002;
        public const uint ModShift = 0x0004;

        private const int WmHotkey = 0x0312;
        private const int HotkeyId = 9000;

        private readonly IntPtr _handle;
        private readonly HwndSource _source;
        private bool _registered;

        public event Action Pressed;

        public HotkeyManager(System.Windows.Window window)
        {
            WindowInteropHelper helper = new WindowInteropHelper(window);
            _handle = helper.EnsureHandle();
            _source = HwndSource.FromHwnd(_handle);
            _source.AddHook(WndProc);
        }

        public bool Register(uint modifiers, uint key)
        {
            _registered = RegisterHotKey(_handle, HotkeyId, modifiers, key);
            return _registered;
        }

        private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
        {
            if (msg == WmHotkey && wParam.ToInt32() == HotkeyId)
            {
                Action handler = Pressed;
                if (handler != null) handler();
                handled = true;
            }
            return IntPtr.Zero;
        }

        public void Dispose()
        {
            if (_registered)
            {
                UnregisterHotKey(_handle, HotkeyId);
                _registered = false;
            }
            if (_source != null)
            {
                _source.RemoveHook(WndProc);
            }
        }
    }
}
