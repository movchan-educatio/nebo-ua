Add-Type -AssemblyName System.Drawing
function New-NeboIcon([int]$Size, [string]$Path) {
  $bitmap = [System.Drawing.Bitmap]::new($Size, $Size)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.Clear([System.Drawing.Color]::FromArgb(7,16,24))
  $margin = [int]($Size * 0.12)
  $brush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(91,188,255))
  $graphics.FillEllipse($brush, $margin, $margin, $Size - 2*$margin, $Size - 2*$margin)
  $dark = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(7,16,24))
  $graphics.FillEllipse($dark, [int]($Size*.31), [int]($Size*.18), [int]($Size*.55), [int]($Size*.55))
  $font = [System.Drawing.Font]::new('Arial', [float]($Size*.19), [System.Drawing.FontStyle]::Bold)
  $white = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
  $format = [System.Drawing.StringFormat]::new()
  $format.Alignment = [System.Drawing.StringAlignment]::Center
  $graphics.DrawString('UA', $font, $white, [System.Drawing.RectangleF]::new(0,[float]($Size*.62),$Size,[float]($Size*.25)), $format)
  $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $format.Dispose(); $white.Dispose(); $font.Dispose(); $dark.Dispose(); $brush.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
}
New-NeboIcon 192 (Join-Path $PSScriptRoot '..\assets\icons\icon-192.png')
New-NeboIcon 512 (Join-Path $PSScriptRoot '..\assets\icons\icon-512.png')
New-NeboIcon 512 (Join-Path $PSScriptRoot '..\assets\icons\icon-maskable-512.png')
