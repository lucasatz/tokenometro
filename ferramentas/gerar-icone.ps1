# Gera icon.png (128x128) e icon-512.png na pasta informada, mais uma previa sobre fundo claro e escuro.
# Uso: powershell -File ferramentas\gerar-icone.ps1 -Pasta .
# Os comentarios ficam sem acento de proposito: o PowerShell 5.1 le .ps1 sem BOM como ANSI.
param([string]$Pasta)
Add-Type -AssemblyName System.Drawing
$T = 512
function Cor($a, $r, $g, $b) { [System.Drawing.Color]::FromArgb($a, $r, $g, $b) }
# Mesmo tom dos logos da extensao do Claude Code (resources/claude-logo.svg): #D97757
$LARANJA = Cor 255 217 119 87
# Cinza quente (areia) que aparece tanto no tema claro quanto no escuro
$CINZA = Cor 255 181 168 152

function Caneta($cor, $esp, [switch]$Tracejada) {
   $p = New-Object System.Drawing.Pen($cor, $esp)
   $p.StartCap = 'Round'; $p.EndCap = 'Round'; $p.LineJoin = 'Round'
   if ($Tracejada) { $p.DashPattern = @(0.9, 1.5); $p.DashCap = 'Round' }
   return $p
}

$bmp = New-Object System.Drawing.Bitmap($T, $T, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.Clear([System.Drawing.Color]::Transparent)
$cx = 256; $cy = 280; $raio = 200
$ret = New-Object System.Drawing.RectangleF(($cx - $raio), ($cy - $raio), (2 * $raio), (2 * $raio))
$ini = 150; $total = 240; $usado = 168
$g.DrawArc((Caneta $LARANJA 56), $ret, $ini, $usado)
# Tres bolinhas com vaos iguais entre a borda da ponta do arco e a borda do ponto laranja do fim
$pincelCinza = New-Object System.Drawing.SolidBrush($CINZA)
$grau = 180 / [Math]::PI
$raioBola = 16
$inicioVao = $ini + $usado + (56 / 2) / $raio * $grau
$fimVao = $ini + $total - 38 / $raio * $grau
$bola = 2 * $raioBola / $raio * $grau
$vao = ($fimVao - $inicioVao - 3 * $bola) / 4
foreach ($k in 0..2) {
   $a = ($inicioVao + $vao * ($k + 1) + $bola * $k + $bola / 2) / $grau
   $g.FillEllipse($pincelCinza, ($cx + [Math]::Cos($a) * $raio - $raioBola), ($cy + [Math]::Sin($a) * $raio - $raioBola), (2 * $raioBola), (2 * $raioBola))
}
$angFim = ($ini + $total) * [Math]::PI / 180
$g.FillEllipse((New-Object System.Drawing.SolidBrush($LARANJA)), ($cx + [Math]::Cos($angFim) * $raio - 38), ($cy + [Math]::Sin($angFim) * $raio - 38), 76, 76)
$angP = ($ini + $usado) * [Math]::PI / 180
$g.DrawLine((Caneta $LARANJA 36), [float]$cx, [float]$cy, [float]($cx + [Math]::Cos($angP) * ($raio - 78)), [float]($cy + [Math]::Sin($angP) * ($raio - 78)))
$g.FillEllipse((New-Object System.Drawing.SolidBrush($LARANJA)), ($cx - 44), ($cy - 44), 88, 88)
$g.Dispose()
$bmp.Save((Join-Path $Pasta 'icon-512.png'), [System.Drawing.Imaging.ImageFormat]::Png)

$menor = New-Object System.Drawing.Bitmap(128, 128, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g2 = [System.Drawing.Graphics]::FromImage($menor)
$g2.Clear([System.Drawing.Color]::Transparent)
$g2.InterpolationMode = 'HighQualityBicubic'; $g2.PixelOffsetMode = 'HighQuality'; $g2.CompositingQuality = 'HighQuality'
$g2.DrawImage($bmp, 0, 0, 128, 128); $g2.Dispose()
$menor.Save((Join-Path $Pasta 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)

# Previa do mesmo PNG sobre fundo claro e escuro, so para conferir
$previa = New-Object System.Drawing.Bitmap(860, 440)
$gp = [System.Drawing.Graphics]::FromImage($previa)
$gp.SmoothingMode = 'AntiAlias'; $gp.InterpolationMode = 'HighQualityBicubic'; $gp.TextRenderingHint = 'AntiAliasGridFit'
$gp.FillRectangle((New-Object System.Drawing.SolidBrush((Cor 255 255 255 255))), 0, 0, 430, 440)
$gp.FillRectangle((New-Object System.Drawing.SolidBrush((Cor 255 30 30 30))), 430, 0, 430, 440)
$gp.DrawImage($bmp, 55, 30, 320, 320)
$gp.DrawImage($bmp, 485, 30, 320, 320)
$fonte = New-Object System.Drawing.Font('Segoe UI', 18, [System.Drawing.FontStyle]::Bold)
$gp.DrawString('tema claro', $fonte, (New-Object System.Drawing.SolidBrush((Cor 255 40 40 40))), 155, 380)
$gp.DrawString('tema escuro', $fonte, (New-Object System.Drawing.SolidBrush((Cor 255 230 230 230))), 580, 380)
$gp.Dispose()
$previa.Save((Join-Path $Pasta 'previa.png'), [System.Drawing.Imaging.ImageFormat]::Png)
"ok"
