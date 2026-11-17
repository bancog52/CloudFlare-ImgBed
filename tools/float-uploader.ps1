Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$UploadScript = Join-Path $ScriptDir 'upload.mjs'

$script:FormatMode = 'md' # md | url | html
$script:LastUrl = ''
$script:LastName = 'image'
$script:UiMode = 'idle'   # idle | busy | ok | copied | err
$script:StatusMsg = ''
$script:Progress = 0
$script:UploadStartMs = 0
$script:EstDurationMs = 2000
$script:Dragging = $false
$script:DragMoved = $false
$script:DragOffset = [System.Drawing.Point]::Empty
$script:ActiveProc = $null
$script:ActivePaths = @()
$script:DeleteTemp = $false

function Format-Output([string]$url, [string]$name) {
  switch ($script:FormatMode) {
    'url'  { return $url }
    'html' { return "<img src=`"$url`" alt=`"$name`" />" }
    default { return "![$name]($url)" }
  }
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
using System.Windows.Forms;
public class FloatForm : Form {
  public FloatForm() {
    this.DoubleBuffered = true;
    this.SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer, true);
  }
}
"@ -ReferencedAssemblies System.Windows.Forms, System.Drawing

$form = New-Object FloatForm
$form.Text = 'ImgHub'
$form.Size = New-Object System.Drawing.Size(60, 60)
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.AllowDrop = $true
$form.Opacity = 0.95
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.Cursor = [System.Windows.Forms.Cursors]::Hand

$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$form.Location = New-Object System.Drawing.Point(($wa.Right - 86), ($wa.Bottom - 104))

$circlePath = New-Object System.Drawing.Drawing2D.GraphicsPath
$circlePath.AddEllipse(1, 1, $form.Width - 2, $form.Height - 2)
$form.Region = New-Object System.Drawing.Region($circlePath)

$tip = New-Object System.Windows.Forms.ToolTip

function Set-UiState([string]$mode, [string]$msg = '') {
  $script:UiMode = $mode
  $script:StatusMsg = $msg
  switch ($mode) {
    'idle' {
      $tip.SetToolTip($form, "ImgHub ($($script:FormatMode.ToUpper()))`nDrag image here, or click to upload clipboard")
    }
    'busy' {
      $tip.SetToolTip($form, 'Uploading...')
    }
    'ok' {
      $tip.SetToolTip($form, "Copied! Click to copy again`n$msg")
    }
    'copied' {
      $tip.SetToolTip($form, "Copied!`n$msg")
    }
    'err' {
      $tip.SetToolTip($form, "Upload failed: $msg")
    }
  }
  $form.Invalidate()
}

$form.Add_Paint({
  param($s, $e)
  $g = $e.Graphics
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

  $w = $form.Width
  $h = $form.Height
  $cx = $w / 2.0
  $cy = $h / 2.0

  switch ($script:UiMode) {
    'idle' {
      # Apple-style ceramic/glass circle with subtle top highlight and SF-style cloud-upload icon
      $bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        [System.Drawing.Point]::new(0, 0),
        [System.Drawing.Point]::new(0, $h),
        [System.Drawing.Color]::FromArgb(255, 255, 255),
        [System.Drawing.Color]::FromArgb(242, 244, 247)
      )
      $g.FillEllipse($bgBrush, 2, 2, $w - 4, $h - 4)
      $bgBrush.Dispose()

      $ringPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(216, 222, 232), 1.5)
      $g.DrawEllipse($ringPen, 2, 2, $w - 4, $h - 4)
      $ringPen.Dispose()

      $hiPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(220, 255, 255, 255), 1.5)
      $g.DrawArc($hiPen, 3.5, 3.5, $w - 7, $h - 7, 200, 140)
      $hiPen.Dispose()

      # SF-style cloud outline centered at ($cx, $cy)
      $cloudPath = New-Object System.Drawing.Drawing2D.GraphicsPath
      $cloudPath.AddArc([float]($cx - 12.5), [float]($cy - 2.0), 10.0, 10.0, 90, 165)
      $cloudPath.AddArc([float]($cx - 7.5), [float]($cy - 9.5), 14.0, 14.0, 195, 165)
      $cloudPath.AddArc([float]($cx + 3.5), [float]($cy - 2.5), 9.0, 10.5, 285, 165)
      $cloudPath.CloseFigure()

      $cloudFill = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(28, 0, 122, 255))
      $g.FillPath($cloudFill, $cloudPath)
      $cloudFill.Dispose()

      $sfBlue = [System.Drawing.Color]::FromArgb(0, 122, 255)
      $cloudPen = New-Object System.Drawing.Pen($sfBlue, 2.1)
      $cloudPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
      $g.DrawPath($cloudPen, $cloudPath)
      $cloudPen.Dispose()
      $cloudPath.Dispose()

      # Crisp centered upload arrow inside/below cloud
      $arrowPen = New-Object System.Drawing.Pen($sfBlue, 2.2)
      $arrowPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
      $arrowPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
      $arrowPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
      $g.DrawLine($arrowPen, [float]$cx, [float]($cy + 10.5), [float]$cx, [float]($cy + 0.5))
      $g.DrawLine($arrowPen, [float]($cx - 3.8), [float]($cy + 4.3), [float]$cx, [float]($cy + 0.5))
      $g.DrawLine($arrowPen, [float]($cx + 3.8), [float]($cy + 4.3), [float]$cx, [float]($cy + 0.5))
      $arrowPen.Dispose()
    }
    'busy' {
      $bgBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(245, 249, 255))
      $g.FillEllipse($bgBrush, 2, 2, $w - 4, $h - 4)
      $bgBrush.Dispose()

      $ringPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(219, 234, 254), 1.5)
      $g.DrawEllipse($ringPen, 2, 2, $w - 4, $h - 4)
      $ringPen.Dispose()

      $trackPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(224, 236, 255), 3.4)
      $g.DrawEllipse($trackPen, 8, 8, $w - 16, $h - 16)
      $trackPen.Dispose()

      $sweep = [float]([Math]::Max(10, ($script:Progress / 100.0) * 360.0))
      $spinPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(0, 122, 255), 3.4)
      $spinPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
      $spinPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
      $g.DrawArc($spinPen, 8, 8, $w - 16, $h - 16, -90, $sweep)
      $spinPen.Dispose()

      $sf = New-Object System.Drawing.StringFormat
      $sf.Alignment = [System.Drawing.StringAlignment]::Center
      $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
      $font = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Bold)
      $pctBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(0, 102, 220))
      $g.DrawString("$([int]$script:Progress)%", $font, $pctBrush, [System.Drawing.RectangleF]::new(0, 0, $w, $h), $sf)
      $pctBrush.Dispose()
      $font.Dispose()
      $sf.Dispose()
    }
    'ok' {
      $bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        [System.Drawing.Point]::new(0, 0),
        [System.Drawing.Point]::new(0, $h),
        [System.Drawing.Color]::FromArgb(52, 199, 89),
        [System.Drawing.Color]::FromArgb(40, 180, 75)
      )
      $g.FillEllipse($bgBrush, 2, 2, $w - 4, $h - 4)
      $bgBrush.Dispose()

      $checkPen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, 3.6)
      $checkPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
      $checkPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
      $checkPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
      $g.DrawLines($checkPen, [System.Drawing.PointF[]]@(
        [System.Drawing.PointF]::new($cx - 9, $cy + 1),
        [System.Drawing.PointF]::new($cx - 2, $cy + 8),
        [System.Drawing.PointF]::new($cx + 10, $cy - 7)
      ))
      $checkPen.Dispose()
    }
    'copied' {
      $bgBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(36, 138, 61))
      $g.FillEllipse($bgBrush, 2, 2, $w - 4, $h - 4)
      $bgBrush.Dispose()

      $sf = New-Object System.Drawing.StringFormat
      $sf.Alignment = [System.Drawing.StringAlignment]::Center
      $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
      $font = New-Object System.Drawing.Font('Segoe UI', 11, [System.Drawing.FontStyle]::Bold)
      $g.DrawString('OK', $font, [System.Drawing.Brushes]::White, [System.Drawing.RectangleF]::new(0, 0, $w, $h), $sf)
      $font.Dispose()
      $sf.Dispose()
    }
    'err' {
      $bgBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 59, 48))
      $g.FillEllipse($bgBrush, 2, 2, $w - 4, $h - 4)
      $bgBrush.Dispose()

      $xPen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, 3.2)
      $xPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
      $xPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
      $g.DrawLine($xPen, [float]($cx - 7.5), [float]($cy - 7.5), [float]($cx + 7.5), [float]($cy + 7.5))
      $g.DrawLine($xPen, [float]($cx + 7.5), [float]($cy - 7.5), [float]($cx - 7.5), [float]($cy + 7.5))
      $xPen.Dispose()
    }
  }
})

Set-UiState 'idle'

$flashTimer = New-Object System.Windows.Forms.Timer
$flashTimer.Interval = 700
$flashTimer.Add_Tick({
  $flashTimer.Stop()
  if ($script:LastUrl) { Set-UiState 'ok' $script:LastUrl } else { Set-UiState 'idle' }
})

$pollTimer = New-Object System.Windows.Forms.Timer
$pollTimer.Interval = 50
$pollTimer.Add_Tick({
  if ($script:UiMode -eq 'busy') {
    $elapsed = [Environment]::TickCount - $script:UploadStartMs
    $ratio = [Math]::Min(0.92, $elapsed / [double]$script:EstDurationMs)
    $script:Progress = [int]([Math]::Max(5, [Math]::Round($ratio * 100)))
    $form.Invalidate()
  }

  $proc = $script:ActiveProc
  if ($proc -and $proc.HasExited) {
    $pollTimer.Stop()
    $script:Progress = 100
    $stdout = $proc.StandardOutput.ReadToEnd().Trim()
    $stderr = $proc.StandardError.ReadToEnd().Trim()
    $code = $proc.ExitCode
    $proc.Dispose()
    $script:ActiveProc = $null

    $paths = $script:ActivePaths
    if ($script:DeleteTemp) {
      foreach ($p in $paths) { Remove-Item -LiteralPath $p -Force -EA SilentlyContinue }
    }

    if ($code -eq 0 -and $stdout) {
      $urls = @($stdout -split "\r?\n" | Where-Object { $_ -match '^https?://' })
      if ($urls.Count -gt 0) {
        $script:LastUrl = $urls[-1]
        $script:LastName = [System.IO.Path]::GetFileNameWithoutExtension($paths[-1])
        $formatted = @()
        for ($i = 0; $i -lt $urls.Count; $i++) {
          $n = if ($i -lt $paths.Count) { [System.IO.Path]::GetFileNameWithoutExtension($paths[$i]) } else { 'image' }
          $formatted += (Format-Output $urls[$i] $n)
        }
        Set-ClipboardSafe ($formatted -join "`r`n")
        Set-UiState 'ok' $script:LastUrl
        return
      }
    }
    $errMsg = if ($stderr) { $stderr } else { "Exit $code" }
    Set-UiState 'err' $errMsg
  }
})

function Run-Upload([string[]]$paths, [bool]$deleteTemp = $false) {
  if ($script:ActiveProc -or -not $paths -or $paths.Count -eq 0) { return }

  $totalBytes = 0L
  foreach ($p in $paths) {
    try { $totalBytes += (Get-Item -LiteralPath $p).Length } catch {}
  }
  $script:UploadStartMs = [Environment]::TickCount
  $script:EstDurationMs = [int][Math]::Max(1500, 1200 + ($totalBytes / 1024.0 / 1024.0) * 2400)
  $script:Progress = 5

  $argList = @("`"$UploadScript`"")
  foreach ($p in $paths) { $argList += "`"$p`"" }

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'node'
  $psi.Arguments = ($argList -join ' ')
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
  $script:ActivePaths = $paths
  $script:DeleteTemp = $deleteTemp
  Set-UiState 'busy'
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
      if ($script:UiMode -eq 'ok' -and $script:LastUrl) {
        Set-ClipboardSafe (Format-Output $script:LastUrl $script:LastName)
        Set-UiState 'copied' $script:LastUrl
        $flashTimer.Stop()
        $flashTimer.Start()
      } elseif ($script:UiMode -eq 'err') {
        Set-UiState 'idle'
      } else {
        if (-not (Upload-ClipboardImage)) {
          if ($script:LastUrl) {
            Set-ClipboardSafe (Format-Output $script:LastUrl $script:LastName)
            Set-UiState 'copied' $script:LastUrl
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

$menu.Items.Add('-') | Out-Null

$itemMd = $menu.Items.Add('Format: Markdown *')
$itemUrl = $menu.Items.Add('Format: URL')
$itemHtml = $menu.Items.Add('Format: HTML <img>')

function Update-FormatMenu() {
  $itemMd.Text = if ($script:FormatMode -eq 'md') { 'Format: Markdown *' } else { 'Format: Markdown' }
  $itemUrl.Text = if ($script:FormatMode -eq 'url') { 'Format: URL *' } else { 'Format: URL' }
  $itemHtml.Text = if ($script:FormatMode -eq 'html') { 'Format: HTML <img> *' } else { 'Format: HTML <img>' }
  if ($script:LastUrl) {
    Set-ClipboardSafe (Format-Output $script:LastUrl $script:LastName)
  }
}
Update-FormatMenu

$itemMd.Add_Click({ $script:FormatMode = 'md'; Update-FormatMenu })
$itemUrl.Add_Click({ $script:FormatMode = 'url'; Update-FormatMenu })
$itemHtml.Add_Click({ $script:FormatMode = 'html'; Update-FormatMenu })

$menu.Items.Add('-') | Out-Null
$itemReset = $menu.Items.Add('Reset')
$itemReset.Add_Click({ $script:LastUrl = ''; Set-UiState 'idle' })

$itemExit = $menu.Items.Add('Exit')
$itemExit.Add_Click({ $form.Close() })

$form.ContextMenuStrip = $menu

[System.Windows.Forms.Application]::Run($form)
