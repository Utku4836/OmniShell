using System;
using System.Drawing;
using System.Windows.Forms;

namespace SiyahUygulama
{
    public class TrayController : IDisposable
    {
        private readonly NotifyIcon _icon;

        public TrayController(MainWindow window)
        {
            var menu = new ContextMenuStrip();
            menu.Items.Add("Aç", null, delegate { window.ShowPanel(); });
            menu.Items.Add("Gizle", null, delegate { window.HidePanel(); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Kapat", null, delegate { window.Close(); });

            _icon = new NotifyIcon
            {
                Text = "Siyah Uygulama",
                Visible = true,
                Icon = CreateIcon(),
                ContextMenuStrip = menu
            };

            _icon.DoubleClick += delegate { window.TogglePanel(); };
        }

        private static Icon CreateIcon()
        {
            using (Bitmap bmp = new Bitmap(32, 32))
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.Clear(Color.Transparent);
                using (SolidBrush brush = new SolidBrush(Color.Black))
                {
                    g.FillEllipse(brush, 1, 1, 30, 30);
                }
                return Icon.FromHandle(bmp.GetHicon());
            }
        }

        public void Dispose()
        {
            _icon.Visible = false;
            _icon.Dispose();
        }
    }
}
