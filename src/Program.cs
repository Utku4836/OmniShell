using System;
using System.Windows;

namespace SiyahUygulama
{
    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            Application app = new Application();
            app.ShutdownMode = ShutdownMode.OnMainWindowClose;
            MainWindow window = new MainWindow();
            app.Run(window);
        }
    }
}
