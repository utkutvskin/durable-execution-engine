# STATE

Bu dosyayı her session A1/A2'ye göre günceller. En son girdi en üstte durur (en yeniden en eskiye). Her girdi kendi başına okunabilir olmalı; önceki günün notuna bakmaya gerek kalmasın.

Alan sözlüğü:
- **Gün:** backlog'daki gün numarası.
- **Durum:** `IN_PROGRESS` | `DONE` | `BLOCKED`.
- **Tamamlanan gün:** bu girdi kapanışta yazıldıysa DONE olan son gün numarası; sonraki session bir sonraki günü buradan hesaplar.
- **Eklenen/değişen dosyalar:** kısa liste.
- **Teknik kararlar:** varsa `docs/DECISIONS.md`'ye eklenen ADR'lere referans.
- **BLOCKER:** doluysa bir sonraki session önce bunu çözer. Boşsa `-`.
- **Devir notu:** yarına bırakılan, unutulmaması gereken tek satırlık not.

---

## Gün 0 (başlangıç)

- **Durum:** DONE
- **Tamamlanan gün:** 0
- **Eklenen/değişen dosyalar:** `docs/BACKLOG.md`, `STATE.md`, `docs/CONVENTIONS.md`, `CLAUDE.md`
- **Teknik kararlar:** -
- **BLOCKER:** -
- **Devir notu:** Gün 1'den başla (monorepo iskeleti ve CI). Başlamadan önce `docs/CONVENTIONS.md` oku, A1 adım 2 zorunlu.
