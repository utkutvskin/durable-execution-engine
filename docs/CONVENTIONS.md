# Yazım ve commit tercihleri

Bu dosya proje sahibinin kalıcı tercihlerini tanımlar. Her session'ın başında okunur (`docs/BACKLOG.md`, A1 adım 2). Yazım konusunda bu dosya ile backlog çelişirse bu dosya kazanır.

Bu kurallar makineye değil repoya bağlıdır. Hangi agent, hangi araç veya hangi makine çalışırsa çalışsın geçerlidir.

---

## 1. Lowercase yazım

Repoya veya GitHub'a giden her metin lowercase yazılır. Sadece özel isimler büyük harfle başlar.

**Kapsam:** commit mesajları, PR başlık ve açıklamaları, branch adları, kod yorumları, log ve hata mesajları, README ve diğer dokümanlar.

**Gerçek yazımını koruyan istisnalar:**

- Özel isimler: `TypeScript`, `PostgreSQL`, `Postgres`, `Node`, `Docker`, `GitHub`, `Vitest`, `Prometheus`, `Grafana`, `Jaeger`, `OpenTelemetry`, `Playwright`.
- Kod tanımlayıcıları, kodda nasıl yazılıyorsa aynen öyle: `EventStore`, `ConcurrencyError`, `NonDeterminismError`, `RetryPolicy`, `ctx.sleep()`, `parentClosePolicy`.
- Yerleşik kısaltmalar: `API`, `CLI`, `UI`, `DSL`, `CI`, `SQL`, `HTTP`, `REST`, `ADR`, `DLQ`, `LRU`, `SSE`, `ETL`.
- Veritabanı durum sabitleri kodda nasılsa öyle: `RUNNING`, `COMPLETED`, `CANCELLED`.

**Conventional commit örnekleri:**

```
feat(core): append-only event store with optimistic concurrency
fix(worker): renew lease before visibility timeout expires
test(core): recorded history replay harness
chore(state): day 07 complete
```

Tip zaten lowercase. Açıklama da lowercase kalır. Cümle büyük harfle başlamaz.

**Mevcut dosyalar:** bu kural agent'ların yazdığı yeni metni bağlar. Proje sahibinin kendi yazdığı `docs/BACKLOG.md` ve `STATE.md` dosyaları olduğu gibi kalır, onları lowercase'e çevirme. `STATE.md` içine eklenen yeni girdilerin serbest metin kısmı bu kurala uyar.

---

## 2. AI attribution yok

Commit mesajlarına `Co-Authored-By: Claude ...` veya benzeri bir satır eklenmez. PR açıklamalarına "Generated with Claude Code" benzeri bir satır eklenmez. Hiçbir AI aracı commit veya PR metninde yazar olarak görünmez.

**Gerekçe:** proje sahibi bu işi kendi adı altında yayınlıyor ve GitHub contributor listesinde bir AI aracı istemiyor. Trailer eklendiği anda GitHub o aracı contributor olarak sayar.

Claude Code kullanan bir agent bunu makine seviyesinde de kapatabilir:

```json
// ~/.claude/settings.json
{ "attribution": { "commit": "", "pr": "" } }
```

O ayar makineye özeldir ve başka bir makinede veya başka bir araçta çalışan agent'ı bağlamaz. Bağlayıcı olan bu dosyadır.

---

## 3. Yanlışlıkla eklenen attribution

`docs/BACKLOG.md` A3 gereği `git push --force` ve history rewrite yasaktır. Bir commit yanlışlıkla attribution satırı içeriyorsa:

- Henüz push edilmediyse `git commit --amend` ile düzelt.
- Push edildiyse kendi başına düzeltmeye çalışma. `STATE.md` içindeki `BLOCKER` alanına hangi commit olduğunu yaz ve proje sahibine bırak. History rewrite kararı ona aittir.
