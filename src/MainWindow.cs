using System;
using System.Collections.Generic;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;

namespace SiyahUygulama
{
    public class MainWindow : Window
    {
        private const int WmNchittest = 0x0084;
        private const int EdgeSize = 8;
        private const double RowHeight = 36;

        private static readonly string[] Tools = new string[]
        {
            "Claude Code",
            "Codex",
            "OpenCode",
            "Kilo Code",
            "Antigravity CLI",
            "Aider",
            "GitHub Copilot CLI",
            "Cursor Agent",
            "Amp",
            "Goose",
            "Crush",
            "Qwen Code",
            "WebTorrent CLI",
            "Torlink"
        };

        private readonly StackPanel _itemsHost = new StackPanel();
        private readonly Canvas _markerLayer = new Canvas();
        private readonly List<TextBlock> _nameBlocks = new List<TextBlock>();
        private TextBlock _marker;
        private ScrollViewer _scroller;

        private int _selectedIndex;
        private double _barCurrent;
        private double _barTarget;
        private double _scrollCurrent;
        private double _scrollTarget;
        private bool _renderingHooked;

        private TrayController _tray;
        private HotkeyManager _hotkeys;

        public MainWindow()
        {
            Title = "Siyah Uygulama";
            WindowStyle = WindowStyle.None;
            AllowsTransparency = true;
            Background = Brushes.Transparent;
            ResizeMode = ResizeMode.CanResize;
            WindowStartupLocation = WindowStartupLocation.CenterScreen;
            Width = 1100;
            Height = 720;
            MinWidth = 400;
            MinHeight = 300;
            Opacity = 0;

            Border panel = new Border
            {
                Background = Brushes.Black,
                CornerRadius = new CornerRadius(28)
            };

            _markerLayer.IsHitTestVisible = false;

            Grid host = new Grid();
            host.Margin = new Thickness(56, 48, 44, 40);
            host.Children.Add(_itemsHost);
            host.Children.Add(_markerLayer);

            _scroller = new ScrollViewer
            {
                Content = host,
                VerticalScrollBarVisibility = ScrollBarVisibility.Hidden
            };

            panel.Child = _scroller;
            Content = panel;

            ContextMenu = BuildContextMenu();

            MouseLeftButtonDown += OnMouseLeftButtonDown;
            SourceInitialized += OnSourceInitialized;
            Closed += OnClosed;
            Loaded += OnLoaded;
        }

        private void OnLoaded(object sender, RoutedEventArgs e)
        {
            BuildItems();
            SnapToSelection();

            DoubleAnimation fade = new DoubleAnimation();
            fade.To = 1d;
            fade.Duration = new Duration(TimeSpan.FromMilliseconds(260));
            fade.EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut };
            BeginAnimation(OpacityProperty, fade);

            CompositionTarget.Rendering += OnFrameTick;
            _renderingHooked = true;
        }

        private void BuildItems()
        {
            _itemsHost.Children.Clear();
            _nameBlocks.Clear();

            _marker = new TextBlock
            {
                Text = ">",
                FontFamily = new FontFamily("Consolas"),
                FontSize = 20,
                FontWeight = FontWeights.Bold,
                Foreground = Brushes.White,
                Height = RowHeight,
                Padding = new Thickness(0, 4, 0, 0)
            };
            _markerLayer.Children.Add(_marker);
            Canvas.SetLeft(_marker, 16);

            for (int i = 0; i < Tools.Length; i++)
            {
                TextBlock name = new TextBlock
                {
                    Text = Tools[i],
                    FontFamily = new FontFamily("Consolas"),
                    FontSize = 19,
                    FontWeight = FontWeights.Medium,
                    Foreground = new SolidColorBrush(Color.FromRgb(138, 138, 138)),
                    VerticalAlignment = VerticalAlignment.Center,
                    Margin = new Thickness(42, 0, 0, 0)
                };

                Border row = new Border
                {
                    Height = RowHeight,
                    Child = name
                };

                _itemsHost.Children.Add(row);
                _nameBlocks.Add(name);
            }
        }

        private void MoveSelection(int delta)
        {
            _selectedIndex = (_selectedIndex + delta + Tools.Length) % Tools.Length;
            UpdateTargets();
            AnimateRowColors();
        }

        private void UpdateTargets()
        {
            _barTarget = _selectedIndex * RowHeight;

            double view = _scroller.ViewportHeight;
            if (view <= 0) return;

            double rowTop = _selectedIndex * RowHeight;
            if (rowTop - 10 < _scrollTarget)
            {
                _scrollTarget = Math.Max(0, rowTop - 10);
            }
            else if (rowTop + RowHeight + 10 > _scrollTarget + view)
            {
                _scrollTarget = rowTop + RowHeight + 10 - view;
            }
        }

        private void SnapToSelection()
        {
            UpdateTargets();
            _barCurrent = _barTarget;
            _scrollCurrent = _scrollTarget;
            Canvas.SetTop(_marker, _barCurrent);
            _scroller.ScrollToVerticalOffset(_scrollCurrent);

            for (int i = 0; i < Tools.Length; i++)
            {
                _nameBlocks[i].Foreground = new SolidColorBrush(
                    i == _selectedIndex ? Colors.White : Color.FromRgb(138, 138, 138));
            }
        }

        private void AnimateRowColors()
        {
            for (int i = 0; i < Tools.Length; i++)
            {
                SolidColorBrush brush = _nameBlocks[i].Foreground as SolidColorBrush;
                if (brush == null) continue;

                Color target = (i == _selectedIndex)
                    ? Colors.White
                    : Color.FromRgb(138, 138, 138);

                ColorAnimation anim = new ColorAnimation();
                anim.To = target;
                anim.Duration = new Duration(TimeSpan.FromMilliseconds(130));
                anim.EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut };
                brush.BeginAnimation(SolidColorBrush.ColorProperty, anim);
            }
        }

        private void OnFrameTick(object sender, EventArgs e)
        {
            if (Math.Abs(_barTarget - _barCurrent) > 0.25)
            {
                _barCurrent += (_barTarget - _barCurrent) * 0.35;
            }
            else
            {
                _barCurrent = _barTarget;
            }
            Canvas.SetTop(_marker, _barCurrent);

            if (Math.Abs(_scrollTarget - _scrollCurrent) > 0.25)
            {
                _scrollCurrent += (_scrollTarget - _scrollCurrent) * 0.24;
            }
            else
            {
                _scrollCurrent = _scrollTarget;
            }
            _scroller.ScrollToVerticalOffset(_scrollCurrent);
        }

        private void OnPreviewKeyDown(object sender, KeyEventArgs e)
        {
            if (e.Key == Key.Up)
            {
                MoveSelection(-1);
                e.Handled = true;
            }
            else if (e.Key == Key.Down)
            {
                MoveSelection(1);
                e.Handled = true;
            }
        }

        private void OnSourceInitialized(object sender, EventArgs e)
        {
            _tray = new TrayController(this);
            _hotkeys = new HotkeyManager(this);
            _hotkeys.Register(HotkeyManager.ModControl | HotkeyManager.ModAlt, (uint)'S');
            _hotkeys.Pressed += TogglePanel;

            HwndSource source = PresentationSource.FromVisual(this) as HwndSource;
            if (source != null) source.AddHook(WndProc);

            PreviewKeyDown += OnPreviewKeyDown;
        }

        private void OnClosed(object sender, EventArgs e)
        {
            if (_renderingHooked)
            {
                CompositionTarget.Rendering -= OnFrameTick;
                _renderingHooked = false;
            }
            if (_hotkeys != null) _hotkeys.Dispose();
            if (_tray != null) _tray.Dispose();
        }

        private void OnMouseLeftButtonDown(object sender, MouseButtonEventArgs e)
        {
            if (e.ButtonState == MouseButtonState.Pressed)
            {
                try { DragMove(); }
                catch (InvalidOperationException) { }
            }
        }

        private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
        {
            if (msg == WmNchittest)
            {
                long lp = lParam.ToInt64();
                int x = unchecked((short)(lp & 0xFFFF));
                int y = unchecked((short)((lp >> 16) & 0xFFFF));

                Point p = PointFromScreen(new Point(x, y));
                double w = ActualWidth;
                double h = ActualHeight;

                bool left = p.X <= EdgeSize;
                bool right = p.X >= w - EdgeSize;
                bool top = p.Y <= EdgeSize;
                bool bottom = p.Y >= h - EdgeSize;

                IntPtr result = IntPtr.Zero;
                if (top && left) result = (IntPtr)12;
                else if (top && right) result = (IntPtr)14;
                else if (bottom && left) result = (IntPtr)16;
                else if (bottom && right) result = (IntPtr)17;
                else if (left) result = (IntPtr)10;
                else if (right) result = (IntPtr)11;
                else if (top) result = (IntPtr)12;
                else if (bottom) result = (IntPtr)15;

                if (result != IntPtr.Zero)
                {
                    handled = true;
                    return result;
                }
            }
            return IntPtr.Zero;
        }

        private ContextMenu BuildContextMenu()
        {
            MenuItem openItem = new MenuItem { Header = "Show" };
            openItem.Click += delegate { ShowPanel(); };

            MenuItem hideItem = new MenuItem { Header = "Hide" };
            hideItem.Click += delegate { HidePanel(); };

            MenuItem closeItem = new MenuItem { Header = "Close" };
            closeItem.Click += delegate { Close(); };

            ContextMenu menu = new ContextMenu();
            menu.Items.Add(openItem);
            menu.Items.Add(hideItem);
            menu.Items.Add(new Separator());
            menu.Items.Add(closeItem);
            return menu;
        }

        public void ShowPanel()
        {
            Show();
            Activate();
        }

        public void HidePanel()
        {
            Hide();
        }

        public void TogglePanel()
        {
            if (IsVisible) HidePanel();
            else ShowPanel();
        }
    }
}
