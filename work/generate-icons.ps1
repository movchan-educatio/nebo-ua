Add-Type -AssemblyName System.Drawing
function New-NeboIcon([int]$Size, [string]$Path) {
  $bitmap = [System.Drawing.Bitmap]::new($Size, $Size)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.Clear([System.Drawing.Color]::FromArgb(6,16,25))
  $c = [float]($Size / 2)
  $m = [float]($Size * 0.07)
  $R = $c - $m
  $gold = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(245,192,74), [float]($Size * 0.04))
  $graphics.DrawEllipse($gold, $m, $m, 2 * $R, 2 * $R)
  $cyan = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(102,199,255), [float]($Size * 0.016))
  foreach ($k in @(0.72, 0.45)) {
    $r = $R * $k
    $graphics.DrawEllipse($cyan, $c - $r, $c - $r, 2 * $r, 2 * $r)
  }
  $goldBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(245,192,74))
  $redBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255,111,125))
  $whiteBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
  $bd = [float]($Size * 0.085)
  $graphics.FillEllipse($goldBrush, $c + $R * 0.34 - $bd / 2, $c - $R * 0.34 - $bd / 2, $bd, $bd)
  $rd = [float]($Size * 0.065)
  $graphics.FillEllipse($redBrush, $c - $R * 0.3 - $rd / 2, $c + $R * 0.3 - $rd / 2, $rd, $rd)
  $cd = [float]($Size * 0.05)
  $graphics.FillEllipse($whiteBrush, $c - $cd / 2, $c - $cd / 2, $cd, $cd)
  $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $gold.Dispose(); $cyan.Dispose(); $goldBrush.Dispose(); $redBrush.Dispose(); $whiteBrush.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
}
New-NeboIcon 192 (Join-Path $PSScriptRoot '..\assets\icons\icon-192.png')
New-NeboIcon 512 (Join-Path $PSScriptRoot '..\assets\icons\icon-512.png')
New-NeboIcon 512 (Join-Path $PSScriptRoot '..\assets\icons\icon-maskable-512.png')
