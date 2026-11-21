Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$UploadScript = Join-Path $ScriptDir 'upload.mjs'
$ImageExts = @('.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.svg', '.bmp', '.ico', '.tif', '.tiff', '.heic', '.heif', '.apng')

$script:FormatMode = 'md' # md | url | html
$script:LastBatch = @()
$script:RecentList = New-Object System.Collections.ArrayList
$script:UiMode = 'idle'   # idle | busy | ok | copied | err
$script:StatusMsg = ''
$script:Progress = 0
$script:UploadStartMs = 0
$script:EstDurationMs = 2000
$script:IsHovered = $false
$script:Dragging = $false
$script:DragMoved = $false
$script:DragOffset = [System.Drawing.Point]::Empty

$script:ActiveProc = $null
$script:QueuePaths = @()
$script:QueueTotal = 0
$script:QueueIndex = 0
$script:QueueResults = @()
$script:QueueFailed = 0
$script:LastError = ''
$script:DeleteTemp = $false

function Format-Output([string]$url, [string]$name) {
  switch ($script:FormatMode) {
    'url'  { return $url }
    'html' { return "<img src=`"$url`" alt=`"$name`" />" }
    default { return "![$name]($url)" }
  }
}

function Format-Batch([array]$items) {
  if (-not $items -or $items.Count -eq 0) { return '' }
  $lines = @()
  foreach ($it in $items) {
    $lines += (Format-Output $it.url $it.name)
  }
  return ($lines -join "`r`n")
}

function Set-ClipboardSafe([string]$text) {
  if ([string]::IsNullOrWhiteSpace($text)) { return }
  [System.Windows.Forms.Clipboard]::SetText($text)
}

function Get-SystemProxyUrl() {
  try {
    $reg = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -EA SilentlyContinue
    if ($reg.ProxyEnable -eq 1 -and $reg.ProxyServer) {
      $srv = [string]$reg.ProxyServer
      if ($srv -match 'https=([^;]+)') { $srv = $Matches[1] }
      elseif ($srv -match '^([^;=]+)$') { $srv = $Matches[1] }
      if ($srv -notmatch '^https?://') { $srv = "http://$srv" }
      return $srv
    }
  } catch {}
  return ''
}

Add-Type @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class LayeredFloatForm : Form {
  [StructLayout(LayoutKind.Sequential)]
  private struct POINT { public int x; public int y; }
  [StructLayout(LayoutKind.Sequential)]
  private struct SIZE { public int cx; public int cy; }
  [StructLayout(LayoutKind.Sequential, Pack = 1)]
  private struct BLENDFUNCTION {
    public byte BlendOp;
    public byte BlendFlags;
    public byte SourceConstantAlpha;
    public byte AlphaFormat;
  }

  [DllImport("user32.dll", ExactSpelling = true, SetLastError = true)]
  private static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr hdcDst, ref POINT pptDst, ref SIZE psize, IntPtr hdcSrc, ref POINT pprSrc, int crKey, ref BLENDFUNCTION pblend, int dwFlags);
  [DllImport("user32.dll", ExactSpelling = true, SetLastError = true)]
  private static extern IntPtr GetDC(IntPtr hWnd);
  [DllImport("user32.dll", ExactSpelling = true)]
  private static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
  [DllImport("gdi32.dll", ExactSpelling = true, SetLastError = true)]
  private static extern IntPtr CreateCompatibleDC(IntPtr hDC);
  [DllImport("gdi32.dll", ExactSpelling = true, SetLastError = true)]
  private static extern bool DeleteDC(IntPtr hdc);
  [DllImport("gdi32.dll", ExactSpelling = true)]
  private static extern IntPtr SelectObject(IntPtr hDC, IntPtr hObject);
  [DllImport("gdi32.dll", ExactSpelling = true, SetLastError = true)]
  private static extern bool DeleteObject(IntPtr hObject);

  protected override CreateParams CreateParams {
    get {
      CreateParams cp = base.CreateParams;
      cp.ExStyle |= 0x00080000 | 0x00000080; // WS_EX_LAYERED | WS_EX_TOOLWINDOW
      return cp;
    }
  }

  public void SetBitmap(Bitmap bitmap, byte opacity = 255) {
    if (bitmap == null || !this.IsHandleCreated) return;
    IntPtr screenDc = GetDC(IntPtr.Zero);
    IntPtr memDc = CreateCompatibleDC(screenDc);
    IntPtr hBitmap = IntPtr.Zero;
    IntPtr oldBitmap = IntPtr.Zero;
    try {
      hBitmap = bitmap.GetHbitmap(Color.FromArgb(0));
      oldBitmap = SelectObject(memDc, hBitmap);
      SIZE size = new SIZE { cx = bitmap.Width, cy = bitmap.Height };
      POINT topPos = new POINT { x = this.Left, y = this.Top };
      POINT pointSource = new POINT { x = 0, y = 0 };
      BLENDFUNCTION blend = new BLENDFUNCTION {
        BlendOp = 0,
        BlendFlags = 0,
        SourceConstantAlpha = opacity,
        AlphaFormat = 1
      };
      UpdateLayeredWindow(this.Handle, screenDc, ref topPos, ref size, memDc, ref pointSource, 0, ref blend, 2);
    } finally {
      ReleaseDC(IntPtr.Zero, screenDc);
      if (hBitmap != IntPtr.Zero) {
        SelectObject(memDc, oldBitmap);
        DeleteObject(hBitmap);
      }
      DeleteDC(memDc);
    }
  }
}
"@ -ReferencedAssemblies System.Windows.Forms, System.Drawing

function New-RoundedRectPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2.0
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

$form = New-Object LayeredFloatForm
$form.Text = 'ImgHub'
$form.Size = New-Object System.Drawing.Size(84, 84)
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.AllowDrop = $true
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.Cursor = [System.Windows.Forms.Cursors]::Hand

$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$form.Location = New-Object System.Drawing.Point(($wa.Right - 104), ($wa.Bottom - 120))

$tip = New-Object System.Windows.Forms.ToolTip

function Render-FloatIcon() {
  if (-not $form.IsHandleCreated) { return }
  $cw = $form.Width
  $ch = $form.Height
  $bmp = New-Object System.Drawing.Bitmap($cw, $ch, [System.Drawing.Imaging.PixelFormat]::Format32bppPArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.Clear([System.Drawing.Color]::Transparent)

  # 56x56 Apple Squircle centered horizontally, slightly above bottom for soft drop shadow
  $bw = 56.0
  $bh = 56.0
  $bx = ($cw - $bw) / 2.0
  $by = 10.0
  $br = 16.0
  $cx = $bx + $bw / 2.0
  $cy = $by + $bh / 2.0

  # Soft multi-layer macOS-style drop shadow
  $shadows = @(
    @{ dx = 0.0; dy = 6.0; expand = 4.0; alpha = 10 },
    @{ dx = 0.0; dy = 4.5; expand = 2.5; alpha = 16 },
    @{ dx = 0.0; dy = 3.0; expand = 1.2; alpha = 22 },
    @{ dx = 0.0; dy = 1.5; expand = 0.4; alpha = 26 }
  )
  foreach ($sh in $shadows) {
    $sp = New-RoundedRectPath ($bx - $sh.expand + $sh.dx) ($by - $sh.expand + $sh.dy) ($bw + $sh.expand * 2) ($bh + $sh.expand * 2) ($br + $sh.expand * 0.6)
    $sb = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb($sh.alpha, 15, 23, 42))
    $g.FillPath($sb, $sp)
    $sb.Dispose()
    $sp.Dispose()
  }

  $cardPath = New-RoundedRectPath $bx $by $bw $bh $br

  switch ($script:UiMode) {
    'idle' {
      $topC = if ($script:IsHovered) { [System.Drawing.Color]::FromArgb(255, 255, 255, 255) } else { [System.Drawing.Color]::FromArgb(248, 255, 255, 255) }
      $botC = if ($script:IsHovered) { [System.Drawing.Color]::FromArgb(255, 246, 249, 255) } else { [System.Drawing.Color]::FromArgb(245, 241, 245, 249) }
      $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush([System.Drawing.PointF]::new($bx, $by), [System.Drawing.PointF]::new($bx, $by + $bh), $topC, $botC)
      $g.FillPath($bg, $cardPath)
      $bg.Dispose()

      $borderPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(140, 203, 213, 225), 1.1)
      $g.DrawPath($borderPen, $cardPath)
      $borderPen.Dispose()

      $innerPath = New-RoundedRectPath ($bx + 1.0) ($by + 1.0) ($bw - 2.0) ($bh - 2.0) ($br - 1.0)
      $hiPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(200, 255, 255, 255), 1.0)
      $g.DrawPath($hiPen, $innerPath)
      $hiPen.Dispose()
      $innerPath.Dispose()

      $cloudPath = New-Object System.Drawing.Drawing2D.GraphicsPath
      $cloudPath.AddArc([float]($cx - 12.5), [float]($cy - 2.0), 10.0, 10.0, 90, 165)
      $cloudPath.AddArc([float]($cx - 7.5), [float]($cy - 9.5), 14.0, 14.0, 195, 165)
      $cloudPath.AddArc([float]($cx + 3.5), [float]($cy - 2.5), 9.0, 10.5, 285, 165)
      $cloudPath.CloseFigure()

      $cloudFill = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(26, 0, 122, 255))
      $g.FillPath($cloudFill, $cloudPath)
      $cloudFill.Dispose()

      $sfBlue = [System.Drawing.Color]::FromArgb(0, 122, 255)
      $cloudPen = New-Object System.Drawing.Pen($sfBlue, 2.0)
      $cloudPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
      $g.DrawPath($cloudPen, $cloudPath)
      $cloudPen.Dispose()
      $cloudPath.Dispose()

      $arrowPen = New-Object System.Drawing.Pen($sfBlue, 2.1)
      $arrowPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
      $arrowPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
      $arrowPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
      $g.DrawLine($arrowPen, [float]$cx, [float]($cy + 10.0), [float]$cx, [float]($cy + 0.5))
      $g.DrawLine($arrowPen, [float]($cx - 3.6), [float]($cy + 4.1), [float]$cx, [float]($cy + 0.5))
      $g.DrawLine($arrowPen, [float]($cx + 3.6), [float]($cy + 4.1), [float]$cx, [float]($cy + 0.5))
      $arrowPen.Dispose()
    }
    'busy' {
      $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush([System.Drawing.PointF]::new($bx, $by), [System.Drawing.PointF]::new($bx, $by + $bh), [System.Drawing.Color]::FromArgb(250, 245, 249, 255), [System.Drawing.Color]::FromArgb(250, 235, 243, 255))
      $g.FillPath($bg, $cardPath)
      $bg.Dispose()

      $borderPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(160, 191, 219, 254), 1.1)
      $g.DrawPath($borderPen, $cardPath)
      $borderPen.Dispose()

      $ringR = 19.0
      $trackPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(219, 234, 254), 3.3)
      $g.DrawEllipse($trackPen, [float]($cx - $ringR), [float]($cy - $ringR), [float]($ringR * 2), [float]($ringR * 2))
      $trackPen.Dispose()

      $sweep = [float]([Math]::Max(10, ($script:Progress / 100.0) * 360.0))
      $spinPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(0, 122, 255), 3.3)
      $spinPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
      $spinPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
      $g.DrawArc($spinPen, [float]($cx - $ringR), [float]($cy - $ringR), [float]($ringR * 2), [float]($ringR * 2), -90, $sweep)
      $spinPen.Dispose()

      $centerLabel = if ($script:QueueTotal -gt 1) {
        "$($script:QueueIndex)/$($script:QueueTotal)"
      } else {
        "$([int]$script:Progress)%"
      }
      $fontSize = if ($centerLabel.Length -ge 5) { 7.8 } else { 9.0 }
      $sf = New-Object System.Drawing.StringFormat
      $sf.Alignment = [System.Drawing.StringAlignment]::Center
      $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
      $font = New-Object System.Drawing.Font('Segoe UI', $fontSize, [System.Drawing.FontStyle]::Bold)
      $pctBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(0, 102, 220))
      $g.DrawString($centerLabel, $font, $pctBrush, [System.Drawing.RectangleF]::new($bx, $by, $bw, $bh), $sf)
      $pctBrush.Dispose()
      $font.Dispose()
      $sf.Dispose()
    }
    'ok' {
      $topC = if ($script:IsHovered) { [System.Drawing.Color]::FromArgb(255, 64, 210, 100) } else { [System.Drawing.Color]::FromArgb(255, 52, 199, 89) }
      $botC = [System.Drawing.Color]::FromArgb(255, 36, 174, 70)
      $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush([System.Drawing.PointF]::new($bx, $by), [System.Drawing.PointF]::new($bx, $by + $bh), $topC, $botC)
      $g.FillPath($bg, $cardPath)
      $bg.Dispose()

      $innerPath = New-RoundedRectPath ($bx + 1.0) ($by + 1.0) ($bw - 2.0) ($bh - 2.0) ($br - 1.0)
      $hiPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(80, 255, 255, 255), 1.0)
      $g.DrawPath($hiPen, $innerPath)
      $hiPen.Dispose()
      $innerPath.Dispose()

      $checkPen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, 3.5)
      $checkPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
      $checkPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
      $checkPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
      $g.DrawLines($checkPen, [System.Drawing.PointF[]]@(
        [System.Drawing.PointF]::new($cx - 9.0, $cy + 0.8),
        [System.Drawing.PointF]::new($cx - 2.0, $cy + 7.5),
        [System.Drawing.PointF]::new($cx + 9.5, $cy - 6.8)
      ))
      $checkPen.Dispose()
    }
    'copied' {
      $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush([System.Drawing.PointF]::new($bx, $by), [System.Drawing.PointF]::new($bx, $by + $bh), [System.Drawing.Color]::FromArgb(255, 40, 155, 70), [System.Drawing.Color]::FromArgb(255, 28, 128, 54))
      $g.FillPath($bg, $cardPath)
      $bg.Dispose()

      $sf = New-Object System.Drawing.StringFormat
      $sf.Alignment = [System.Drawing.StringAlignment]::Center
      $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
      $font = New-Object System.Drawing.Font('Segoe UI', 10.5, [System.Drawing.FontStyle]::Bold)
      $g.DrawString('OK', $font, [System.Drawing.Brushes]::White, [System.Drawing.RectangleF]::new($bx, $by, $bw, $bh), $sf)
      $font.Dispose()
      $sf.Dispose()
    }
    'err' {
      $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush([System.Drawing.PointF]::new($bx, $by), [System.Drawing.PointF]::new($bx, $by + $bh), [System.Drawing.Color]::FromArgb(255, 255, 69, 58), [System.Drawing.Color]::FromArgb(255, 230, 48, 38))
      $g.FillPath($bg, $cardPath)
      $bg.Dispose()

      $xPen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, 3.1)
      $xPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
      $xPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
      $g.DrawLine($xPen, [float]($cx - 7.0), [float]($cy - 7.0), [float]($cx + 7.0), [float]($cy + 7.0))
      $g.DrawLine($xPen, [float]($cx + 7.0), [float]($cy - 7.0), [float]($cx - 7.0), [float]($cy + 7.0))
      $xPen.Dispose()
    }
  }

  $cardPath.Dispose()
  $g.Dispose()
  $form.SetBitmap($bmp)
  $bmp.Dispose()
}

function Set-UiState([string]$mode, [string]$msg = '') {
  $script:UiMode = $mode
  $script:StatusMsg = $msg
  switch ($mode) {
    'idle' {
      $tip.SetToolTip($form, "ImgHub ($($script:FormatMode.ToUpper()))`nDrag images here, or click to upload clipboard")
    }
    'busy' {
      $tip.SetToolTip($form, $msg)
    }
    'ok' {
      $tip.SetToolTip($form, "$msg`nClick to copy all again")
    }
    'copied' {
      $tip.SetToolTip($form, "Copied!`n$msg")
    }
    'err' {
      $tip.SetToolTip($form, "Upload failed: $msg")
    }
  }
  Render-FloatIcon
}

$form.Add_Shown({ Render-FloatIcon })
$form.Add_MouseEnter({ $script:IsHovered = $true; Render-FloatIcon })
$form.Add_MouseLeave({ $script:IsHovered = $false; Render-FloatIcon })

$flashTimer = New-Object System.Windows.Forms.Timer
$flashTimer.Interval = 700
$flashTimer.Add_Tick({
  $flashTimer.Stop()
  if ($script:LastBatch.Count -gt 0) {
    Set-UiState 'ok' "Copied $($script:LastBatch.Count) image(s)"
  } else {
    Set-UiState 'idle'
  }
})

function Start-NextInQueue() {
  $currentPath = $script:QueuePaths[$script:QueueIndex - 1]
  $fileSize = 0L
  try { $fileSize = (Get-Item -LiteralPath $currentPath).Length } catch {}

  $script:UploadStartMs = [Environment]::TickCount
  $script:EstDurationMs = [int][Math]::Max(1500, 1200 + ($fileSize / 1024.0 / 1024.0) * 2400)
  $script:Progress = 5

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'node'
  $psi.Arguments = "`"$UploadScript`" --progress `"$currentPath`""
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
  $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8

  $proxy = Get-SystemProxyUrl
  if ($proxy) {
    $psi.EnvironmentVariables['NODE_USE_ENV_PROXY'] = '1'
    $psi.EnvironmentVariables['HTTPS_PROXY'] = $proxy
    $psi.EnvironmentVariables['HTTP_PROXY'] = $proxy
  }

  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $psi
  [void]$proc.Start()
  $script:ActiveProc = $proc

  $fileName = [System.IO.Path]::GetFileName($currentPath)
  $prefix = if ($script:QueueTotal -gt 1) { "Uploading $($script:QueueIndex)/$($script:QueueTotal): " } else { 'Uploading: ' }
  Set-UiState 'busy' "$prefix$fileName"
}

$pollTimer = New-Object System.Windows.Forms.Timer
$pollTimer.Interval = 50
$pollTimer.Add_Tick({
  if ($script:UiMode -eq 'busy') {
    $elapsed = [Environment]::TickCount - $script:UploadStartMs
    $ratio = [Math]::Min(0.92, $elapsed / [double]$script:EstDurationMs)
    $script:Progress = [int]([Math]::Max(5, [Math]::Round($ratio * 100)))
    Render-FloatIcon
  }

  $proc = $script:ActiveProc
  if ($proc -and $proc.HasExited) {
    $stdout = $proc.StandardOutput.ReadToEnd().Trim()
    $stderr = $proc.StandardError.ReadToEnd().Trim()
    $code = $proc.ExitCode
    $proc.Dispose()
    $script:ActiveProc = $null

    $currentPath = $script:QueuePaths[$script:QueueIndex - 1]
    if ($script:DeleteTemp) {
      Remove-Item -LiteralPath $currentPath -Force -EA SilentlyContinue
    }

    if ($code -eq 0 -and $stdout -match '^(https?://\S+)') {
      $url = $Matches[1]
      $name = [System.IO.Path]::GetFileNameWithoutExtension($currentPath)
      $entry = @{ url = $url; name = $name }
      $script:QueueResults += $entry

      [void]$script:RecentList.Insert(0, $entry)
      while ($script:RecentList.Count -gt 10) {
        $script:RecentList.RemoveAt($script:RecentList.Count - 1)
      }
      Update-RecentMenu
    } else {
      $script:QueueFailed++
      $script:LastError = if ($stderr) { $stderr } else { "Exit $code" }
      try {
        $logPath = Join-Path $ScriptDir 'upload-error.log'
        $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
        Add-Content -LiteralPath $logPath -Value "[$ts] $currentPath -> $($script:LastError)" -Encoding UTF8
      } catch {}
    }

    if ($script:QueueIndex -lt $script:QueueTotal) {
      $script:QueueIndex++
      Start-NextInQueue
      return
    }

    $pollTimer.Stop()
    $script:Progress = 100

    if ($script:QueueResults.Count -gt 0) {
      $script:LastBatch = $script:QueueResults
      Set-ClipboardSafe (Format-Batch $script:LastBatch)
      $summary = "Copied $($script:LastBatch.Count) image(s)"
      if ($script:QueueFailed -gt 0) { $summary += " ($($script:QueueFailed) failed)" }
      Set-UiState 'ok' $summary
    } else {
      Set-UiState 'err' $script:LastError
    }
  }
})

function Run-Upload([string[]]$paths, [bool]$deleteTemp = $false) {
  if ($script:ActiveProc -or -not $paths -or $paths.Count -eq 0) { return }

  $valid = @()
  foreach ($p in $paths) {
    if ($deleteTemp) {
      $valid += $p
    } else {
      $ext = [System.IO.Path]::GetExtension($p).ToLowerInvariant()
      if ($ImageExts -contains $ext) { $valid += $p }
    }
  }
  if ($valid.Count -eq 0) { return }

  $script:QueuePaths = $valid
  $script:QueueTotal = $valid.Count
  $script:QueueIndex = 1
  $script:QueueResults = @()
  $script:QueueFailed = 0
  $script:LastError = ''
  $script:DeleteTemp = $deleteTemp

  Start-NextInQueue
  $pollTimer.Start()
}

function Upload-ClipboardImage() {
  if (-not [System.Windows.Forms.Clipboard]::ContainsImage()) {
    return $false
  }
  $img = [System.Windows.Forms.Clipboard]::GetImage()
  if (-not $img) { return $false }
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("imghub_" + [Guid]::NewGuid().ToString('N') + ".png")
  $img.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
  $img.Dispose()
  Run-Upload @($tmp) $true
  return $true
}

# Drag & Drop
$form.Add_DragEnter({
  param($s, $e)
  if ($e.Data.GetDataPresent([System.Windows.Forms.DataFormats]::FileDrop)) {
    $e.Effect = [System.Windows.Forms.DragDropEffects]::Copy
  } else {
    $e.Effect = [System.Windows.Forms.DragDropEffects]::None
  }
})
$form.Add_DragDrop({
  param($s, $e)
  if ($e.Data.GetDataPresent([System.Windows.Forms.DataFormats]::FileDrop)) {
    $files = [string[]]$e.Data.GetData([System.Windows.Forms.DataFormats]::FileDrop)
    if ($files.Count -gt 0) { Run-Upload $files $false }
  }
})

# Drag window + Click behavior
$form.Add_MouseDown({
  param($s, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
    $script:Dragging = $true
    $script:DragMoved = $false
    $script:DragOffset = New-Object System.Drawing.Point($e.X, $e.Y)
  }
})
$form.Add_MouseMove({
  param($s, $e)
  if ($script:Dragging) {
    if ([Math]::Abs($e.X - $script:DragOffset.X) -gt 3 -or [Math]::Abs($e.Y - $script:DragOffset.Y) -gt 3) {
      $script:DragMoved = $true
    }
    if ($script:DragMoved) {
      $pos = $form.PointToScreen([System.Drawing.Point]::new($e.X, $e.Y))
      $form.Location = [System.Drawing.Point]::new($pos.X - $script:DragOffset.X, $pos.Y - $script:DragOffset.Y)
    }
  }
})
$form.Add_MouseUp({
  param($s, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
    $wasMoved = $script:DragMoved
    $script:Dragging = $false
    if (-not $wasMoved -and $script:UiMode -ne 'busy') {
      if ($script:UiMode -eq 'ok' -and $script:LastBatch.Count -gt 0) {
        Set-ClipboardSafe (Format-Batch $script:LastBatch)
        Set-UiState 'copied' "Copied $($script:LastBatch.Count) image(s)"
        $flashTimer.Stop()
        $flashTimer.Start()
      } elseif ($script:UiMode -eq 'err') {
        Set-UiState 'idle'
      } else {
        if (-not (Upload-ClipboardImage)) {
          if ($script:LastBatch.Count -gt 0) {
            Set-ClipboardSafe (Format-Batch $script:LastBatch)
            Set-UiState 'copied' "Copied $($script:LastBatch.Count) image(s)"
            $flashTimer.Stop()
            $flashTimer.Start()
          }
        }
      }
    }
  }
})

# Context menu
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$itemClip = $menu.Items.Add('Upload Clipboard Image')
$itemClip.Add_Click({ [void](Upload-ClipboardImage) })

$itemRecent = New-Object System.Windows.Forms.ToolStripMenuItem('Recent Uploads')
[void]$menu.Items.Add($itemRecent)

function Update-RecentMenu() {
  $itemRecent.DropDownItems.Clear()
  if ($script:RecentList.Count -eq 0) {
    $empty = $itemRecent.DropDownItems.Add('(Empty)')
    $empty.Enabled = $false
    return
  }
  for ($i = 0; $i -lt $script:RecentList.Count; $i++) {
    $entry = $script:RecentList[$i]
    $label = "$($i + 1). $($entry.name)"
    $sub = $itemRecent.DropDownItems.Add($label)
    $sub.Tag = $entry
    $sub.Add_Click({
      param($sender, $ev)
      $it = $sender.Tag
      Set-ClipboardSafe (Format-Output $it.url $it.name)
      Set-UiState 'copied' $it.url
      $flashTimer.Stop()
      $flashTimer.Start()
    })
  }
}
Update-RecentMenu

$menu.Items.Add('-') | Out-Null

$itemMd = $menu.Items.Add('Format: Markdown *')
$itemUrl = $menu.Items.Add('Format: URL')
$itemHtml = $menu.Items.Add('Format: HTML <img>')

function Update-FormatMenu() {
  $itemMd.Text = if ($script:FormatMode -eq 'md') { 'Format: Markdown *' } else { 'Format: Markdown' }
  $itemUrl.Text = if ($script:FormatMode -eq 'url') { 'Format: URL *' } else { 'Format: URL' }
  $itemHtml.Text = if ($script:FormatMode -eq 'html') { 'Format: HTML <img> *' } else { 'Format: HTML <img>' }
  if ($script:LastBatch.Count -gt 0) {
    Set-ClipboardSafe (Format-Batch $script:LastBatch)
  }
}
Update-FormatMenu

$itemMd.Add_Click({ $script:FormatMode = 'md'; Update-FormatMenu })
$itemUrl.Add_Click({ $script:FormatMode = 'url'; Update-FormatMenu })
$itemHtml.Add_Click({ $script:FormatMode = 'html'; Update-FormatMenu })

$menu.Items.Add('-') | Out-Null
$itemReset = $menu.Items.Add('Reset')
$itemReset.Add_Click({ $script:LastBatch = @(); Set-UiState 'idle' })

$itemExit = $menu.Items.Add('Exit')
$itemExit.Add_Click({ $form.Close() })

$form.ContextMenuStrip = $menu

[System.Windows.Forms.Application]::Run($form)
