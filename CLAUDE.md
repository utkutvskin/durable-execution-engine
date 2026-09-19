# Agent talimatı

Bu repo otomatik daily session'larla ilerler. Tek iş kaynağı `docs/BACKLOG.md` dosyasıdır.

## Her session'ın başında, bu sırayla oku

1. `docs/CONVENTIONS.md` — proje sahibinin yazım ve commit tercihleri. Zorunlu, atlanamaz, hiçbir metin yazmadan önce okunur.
2. `STATE.md` — en üstteki girdi. `BLOCKER` doluysa günün ilk işi odur.
3. `docs/BACKLOG.md` — Bölüm A (operasyon talimatları) ve sadece bugünün gün bloğu.

Sonra `docs/BACKLOG.md` A1 adımlarını sırayla uygula. Session'ı A2 ile kapat.

## Bugünün gün numarası

`STATE.md` içindeki son `DONE` girdinin "Tamamlanan gün" değeri artı bir. Son girdi `BLOCKED` ise gün numarası ilerlemez, aynı günle devam edilir.

## Kısa hatırlatma

Ayrıntısı `docs/CONVENTIONS.md` içinde, çelişki olursa o dosya kazanır.

- Repoya giden her metin lowercase. Sadece özel isimler, kod tanımlayıcıları ve yerleşik kısaltmalar büyük.
- Commit ve PR metinlerinde AI attribution satırı yok.
- `git push --force` ve history rewrite yasak.
- Test yoksa özellik yok. Günde en az 5 anlamlı yeni test.
- Ertesi günün işini bugün yapma.
