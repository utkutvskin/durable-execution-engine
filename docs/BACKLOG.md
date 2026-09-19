# Durable Execution Engine: 30 Günlük Otomatik Session Backlog'u

Bu dosya `docs/BACKLOG.md` olarak repoda durur. Her otomatik daily session'da agent önce bu dosyayı, sonra `STATE.md` dosyasını okur, sadece o günün kapsamını yapar, commit ve push atar.

**Stack (değiştirilemez):** TypeScript (strict), Node 22, PostgreSQL 16, pnpm workspaces, Vitest, Docker Compose.
**Monorepo paketleri:** `packages/core`, `packages/worker`, `packages/api`, `packages/cli`, `apps/ui`, `examples/`.

---

## BÖLÜM A: AGENT OPERASYON TALİMATLARI

### A1. Session başlangıç sırası (her gün, istisnasız)

1. `git checkout main && git pull --ff-only`
2. `docs/CONVENTIONS.md` dosyasının tamamını oku. Proje sahibinin kalıcı yazım ve commit tercihlerini tanımlar. Bu adım atlanamaz: commit mesajı, PR açıklaması, kod yorumu veya doküman yazmadan önce okunmuş olması gerekir. Yazım konusunda bu dosya ile backlog çelişirse `docs/CONVENTIONS.md` kazanır.
3. `STATE.md` dosyasının en son girdisini oku. `BLOCKER` alanı doluysa, bugünün ilk ve öncelikli işi o blocker'ı çözmektir. Blocker çözülmeden günün kendi kapsamına geçme.
4. `docs/BACKLOG.md` içinden bugünün gün numarasını bul (`STATE.md` içindeki son tamamlanan gün + 1). Sadece o günün bloğunu oku.
5. Baseline doğrula: `pnpm install && pnpm run verify`. Kırmızıysa, bugünün birinci işi baseline'ı yeşile çevirmektir ve bu durum `STATE.md` içine yazılır.
6. Günün kapsamını 3-6 alt göreve böl, `STATE.md` içine `IN_PROGRESS` olarak yaz, commit atma.

### A2. Session bitiş sırası

1. `pnpm run verify` yeşil olmalı (lint + typecheck + unit + integration).
2. O günün "Bitti kriteri" maddelerinin her biri için bunu kanıtlayan bir test veya çalıştırılabilir komut olmalı. Kanıtsız madde tamamlanmış sayılmaz.
3. `STATE.md` güncelle: tamamlanan gün, eklenen dosyalar, alınan teknik kararlar, varsa blocker, yarına devredilen not.
4. Yeni bir mimari karar alındıysa `docs/DECISIONS.md` içine ADR formatında ekle (Bağlam / Karar / Sonuç).
5. Commit'leri at, `main`'e push et, `day-NN` annotated tag'i oluştur ve push et.

### A3. Commit kuralları

- Conventional commits: `feat(core): ...`, `fix(worker): ...`, `test(api): ...`, `chore(ci): ...`, `docs: ...`
- Commit mesajı, PR metni, kod yorumu ve doküman yazımı `docs/CONVENTIONS.md` kurallarına uyar: lowercase, sadece özel isimler büyük, hiçbir AI attribution satırı yok.
- Günde 2-6 commit. Tek dev commit yasak, tek satırlık kozmetik commit de yasak.
- Her commit kendi başına derlenmeli ve testleri geçmeli.
- Günün son commit'i mutlaka `STATE.md` güncellemesini içerir ve mesajı `chore(state): day NN complete` olur.
- `git push --force` ve history rewrite kesinlikle yasak.

### A4. Başarısızlık protokolü

Günün kapsamı bitmiyorsa `main`'e kırık kod push etme. Bunun yerine:

1. Çalışmayı `wip/day-NN` branch'ine commit et ve o branch'i push et.
2. `main` üzerinde sadece `STATE.md` güncellemesini commit et: `BLOCKER` alanına ne takıldığını, hangi dosyada, hangi testin kırmızı olduğunu ve denenen iki yaklaşımı yaz.
3. Gün numarasını ilerletme. Ertesi session aynı gün numarasıyla devam eder ve `wip/day-NN` branch'inden çalışmayı geri alır.
4. Aynı gün üst üste 2 kez bloke olursa, o günün kapsamını en küçük çalışan dikey dilime indir, gerisini `docs/DEFERRED.md` dosyasına taşı ve öyle kapat.

### A5. Kapsam disiplini

- Ertesi günün işini bugün yapma. Gün erken biterse Bölüm C'deki yedek görev havuzundan seç.
- Önceki günlerin "Bitti kriteri" maddelerini gevşetme veya silme. Bir kriter yanlışsa `docs/DECISIONS.md` içine gerekçeyle ADR yaz, sonra değiştir.
- `docs/OUT_OF_SCOPE.md` içindekiler v0.1'de yapılmaz: dağıtık consensus, kendi depolama motoru, gRPC, Kubernetes operatörü, multi-region.
- Sır ve kimlik bilgisi commit etme. Sadece `.env.example` güncellenir.
- Yeni üçüncü parti bağımlılık eklemeden önce gerekçesini `STATE.md` içine yaz. Kriptografi, tarih/saat ve kuyruk için hazır paket tercih et, çekirdek runtime mantığını kendin yaz.

### A6. Kalite bariyeri

- Test yoksa özellik yok. Her gün en az 5 anlamlı yeni test eklenir.
- Zamanla ilgili her test sahte saat (fake clock) kullanır, `sleep` ile bekleyen test yazılmaz.
- Integration testleri gerçek Postgres'e karşı koşar (Testcontainers veya compose üzerinde ephemeral schema).
- `any` kullanımı yasak, `unknown` + daraltma kullan. `@ts-expect-error` sadece açıklamalı satırla.
- Public API'ye eklenen her fonksiyonun TSDoc yorumu olur.

---

## BÖLÜM B: 30 GÜNLÜK BACKLOG

### FAZ 1: TEMEL (Gün 1-3)

#### Gün 1: Monorepo iskeleti ve CI

**Hedef:** Boş ama tam kurulu bir geliştirme ortamı.
**Kapsam:** pnpm workspaces, TypeScript strict config, ESLint + Prettier, Vitest kurulumu, `docker-compose.yml` (Postgres 16), `pnpm run verify` script'i (lint + typecheck + test), GitHub Actions CI, `.env.example`, `README.md` iskeleti, `STATE.md` ve `docs/DECISIONS.md` başlangıç dosyaları.
**Bitti kriteri:** Temiz bir checkout'ta `pnpm install && docker compose up -d && pnpm run verify` tek seferde yeşil dönüyor. CI push'ta çalışıyor ve yeşil.
**Commit:** `chore(repo): bootstrap monorepo`, `chore(ci): add verify pipeline`

#### Gün 2: Veritabanı şeması ve migration altyapısı

**Hedef:** Kalıcılık katmanının şekli.
**Kapsam:** Kendi yazdığın basit migration runner'ı veya `node-pg-migrate`. Tablolar: `namespaces`, `workflow_runs`, `run_events`, `tasks`, `timers`, `step_results`. İndeksler ve kısıtlar: `run_events(run_id, sequence_number)` üzerinde unique, `tasks` üzerinde `(state, visible_at)` partial index. Test harness: her test dosyasına izole schema açan helper.
**Bitti kriteri:** `pnpm migrate:up` ve `pnpm migrate:down` idempotent çalışıyor. İki test dosyası aynı anda koştuğunda birbirinin verisini görmüyor (izolasyon testi).
**Commit:** `feat(core): database schema and migrations`

#### Gün 3: Event store ve optimistic concurrency

**Hedef:** Append-only olay günlüğü, tek doğruluk kaynağı.
**Kapsam:** `EventStore` arayüzü: `append(runId, expectedSeq, events[])`, `read(runId, fromSeq)`. Event tipleri için discriminated union ve şema doğrulama (zod). Çakışmada `ConcurrencyError`. Payload serialization için `Codec` arayüzü (v0: JSON).
**Bitti kriteri:** Aynı `expectedSeq` ile eşzamanlı iki append'ten tam olarak biri başarılı oluyor, diğeri `ConcurrencyError` alıyor (50 paralel denemeli stres testi). Olay günlüğü hiçbir kod yolunda güncellenmiyor veya silinmiyor.
**Commit:** `feat(core): append-only event store with optimistic concurrency`

---

### FAZ 2: RUNTIME ÇEKİRDEĞİ (Gün 4-8)

#### Gün 4: Workflow DSL ve komut modeli

**Hedef:** Kullanıcının yazacağı API yüzeyi.
**Kapsam:** `defineWorkflow`, `ctx.step()`, `ctx.sleep()`, `ctx.now()`, `ctx.random()`, `ctx.uuid()`. Komut tipleri: `ScheduleStep`, `StartTimer`, `CompleteRun`, `FailRun`. Workflow ve step kaydı için registry. Henüz kalıcılık yok, hepsi bellekte.
**Bitti kriteri:** Üç adımlı örnek workflow bellekte koşup doğru komut dizisini üretiyor. `ctx.now()` ve `ctx.random()` doğrudan `Date.now()` ve `Math.random()` çağırmıyor, enjekte edilen kaynaktan besleniyor (testle kanıtlı).
**Commit:** `feat(core): workflow dsl and command model`

#### Gün 5: Karar döngüsü ve replay motoru

**Hedef:** Olay günlüğünden durumu yeniden inşa etme.
**Kapsam:** Decision loop: history'yi besle, workflow fonksiyonunu baştan çalıştır, tamamlanmış step'lerin sonucunu history'den ver, ilk tamamlanmamış noktada durdur ve yeni komutları topla. Promise scheduler'ı deterministik sıraya sok (mikro-task sızıntısı olmamalı).
**Bitti kriteri:** Aynı history üzerinde 3 ardışık replay birebir aynı komut dizisini üretiyor. Kısmi history (3 adımın 2'si tamam) verildiğinde sadece 3. adımın komutu üretiliyor.
**Commit:** `feat(core): deterministic replay decision loop`
**Yasak:** Bugün kalıcılığa dokunma, girdi hâlâ bellekteki history dizisi.

#### Gün 6: Non-determinizm tespiti ve replay test harness'ı

**Hedef:** Sessiz bozulmayı imkânsız kılmak.
**Kapsam:** Replay sırasında üretilen komut ile history'deki kayıt karşılaştırması, uyumsuzlukta `NonDeterminismError` (hangi sequence'ta, ne beklenip ne bulundu). Kayıtlı history fixture'ları için `test/fixtures/histories/*.json` ve bunları toplu koşturan harness. Yasak API kullanımını yakalayan sandbox kontrolü (workflow içinde doğrudan `Date`, `Math.random`, `setTimeout` çağrısı hata versin).
**Bitti kriteri:** Kasten değiştirilmiş workflow kodu eski history ile replay edildiğinde açıklayıcı `NonDeterminismError` fırlatıyor. Workflow gövdesinde `Date.now()` çağıran örnek test edilip reddediliyor.
**Commit:** `feat(core): non-determinism detection`, `test(core): recorded history harness`

#### Gün 7: Step çalıştırma sözleşmesi ve payload codec

**Hedef:** Yan etkilerin (activity) tanımlı ve taşınabilir hâli.
**Kapsam:** `defineStep` ile girdi/çıktı şeması, step timeout alanı, hata serileştirme (stack dahil, tipini koruyarak), `Codec` üzerinde büyük payload limiti ve sıkıştırma kancası, hassas alan maskeleme kancası.
**Bitti kriteri:** Step'in fırlattığı özel hata sınıfı serileştirilip geri okunduğunda tipi ve mesajı korunuyor. 1 MB üstü payload açık bir `PayloadTooLargeError` veriyor.
**Commit:** `feat(core): step contract and payload codec`

#### Gün 8: Run projeksiyonu ve durum makinesi

**Hedef:** Olay günlüğünden okunabilir run durumu.
**Kapsam:** `workflow_runs` projeksiyonu, durumlar: `RUNNING`, `COMPLETED`, `FAILED`, `TIMED_OUT`, `CANCELLED`, `TERMINATED`. İzinli geçişler tablosu, geçersiz geçişte hata. Projeksiyonun olay günlüğünden sıfırdan yeniden inşa edilebilmesi (`rebuildProjection`).
**Bitti kriteri:** Projeksiyon tablosu tamamen silinip olay günlüğünden yeniden kurulduğunda önceki hâliyle birebir aynı (property-based test, 200 rastgele olay dizisi). Terminal durumdaki bir run'a yeni komut uygulanamıyor.
**Commit:** `feat(core): run projection and state machine`

---

### FAZ 3: DAĞITIM VE DAYANIKLILIK (Gün 9-13)

#### Gün 9: Task kuyruğu

**Hedef:** İşin worker'lara dağıtılması.
**Kapsam:** `SELECT ... FOR UPDATE SKIP LOCKED` ile dequeue, visibility timeout, `enqueue` / `ack` / `nack` / `extend`, task tipleri (`WORKFLOW_TASK`, `STEP_TASK`), namespace bazlı task queue adı.
**Bitti kriteri:** 8 paralel tüketici 1000 task'ı işlediğinde hiçbir task iki tüketiciye aynı anda verilmiyor ve hiçbiri kaybolmuyor. Ack'lenmeyen task visibility timeout sonrası yeniden görünür oluyor.
**Commit:** `feat(core): task queue with skip-locked dequeue`

#### Gün 10: Idempotency ve tek yazım garantisi

**Hedef:** At-least-once teslimat altında doğruluk.
**Kapsam:** `step_results` üzerinde `(run_id, step_id, attempt_key)` unique kısıtı, step sonucunun ve olay yazımının tek transaction'da atomik olması, tekrar teslimde var olan sonucun döndürülmesi, workflow task'larında da aynı koruma.
**Bitti kriteri:** Aynı step task'ı kasten 5 kez teslim edildiğinde step gövdesi kaç kez çalışırsa çalışsın olay günlüğüne tam olarak bir sonuç yazılıyor. Transaction ortasında kesilen yazım kısmi kayıt bırakmıyor.
**Commit:** `feat(core): idempotent step result recording`

#### Gün 11: Worker süreci, lease ve heartbeat

**Hedef:** Uzun süren işi güvenle tutma.
**Kapsam:** Worker poll döngüsü, eşzamanlılık limiti, heartbeat ile lease uzatma, `WorkerOptions` (queue, concurrency, poll interval), backoff'lu boş kuyruk beklemesi, graceful shutdown (SIGTERM'de yeni task alma, mevcutları bitir, timeout'ta bırak).
**Bitti kriteri:** Heartbeat atan 60 saniyelik bir step, 10 saniyelik visibility timeout'a rağmen başka worker'a devredilmiyor. SIGTERM sonrası çalışan task'lar tamamlanıp süreç temiz çıkıyor (exit code 0).
**Commit:** `feat(worker): poll loop, lease renewal and graceful shutdown`

#### Gün 12: Crash recovery

**Hedef:** Motorun asıl vaadi.
**Kapsam:** Sahipsiz lease reclaim eden janitor görevi, worker kimliği ve sürüm damgası, yarıda kalan run'ların tespiti, recovery metrikleri, `SIGKILL` senaryolarını kuran test altyapısı (worker'ı ayrı süreç olarak başlatıp öldürme).
**Bitti kriteri:** Step'in tam ortasında `SIGKILL` ile öldürülen worker'ın işini ikinci worker devralıp akışı doğru sonuçla bitiriyor. 20 tekrarlı kaos testinde run'ların tamamı terminal duruma ulaşıyor, hiçbiri kayıp kalmıyor.
**Commit:** `feat(worker): crash recovery and lease reclaim`

#### Gün 13: Retry politikaları ve dead letter

**Hedef:** Hata karşısında öngörülebilir davranış.
**Kapsam:** `RetryPolicy` (initialInterval, backoffCoefficient, maxInterval, maxAttempts, jitter), `NonRetryableError`, step-level ve workflow-level timeout, denemelerin olay günlüğüne yazılması, `dead_letters` tablosu ve yeniden kuyruğa alma fonksiyonu.
**Bitti kriteri:** Sahte saatle backoff aralıkları beklenen değerlerle assert ediliyor. `NonRetryableError` hiç tekrar denenmiyor. Maksimum denemesi tükenen step DLQ'ya düşüyor ve manuel olarak yeniden kuyruğa alınabiliyor.
**Commit:** `feat(core): retry policies and dead letter queue`

---

### FAZ 4: ZAMAN VE AKIŞ KONTROLÜ (Gün 14-18)

#### Gün 14: Kalıcı timer'lar

**Hedef:** `ctx.sleep()` in gerçekten dayanıklı hâli.
**Kapsam:** `timers` tablosu, scheduler tick döngüsü, vadesi gelen timer'ın workflow task'ına dönüşmesi, sistem kapalıyken geçen süre için catch-up, saat kayması ve geri gitmeye karşı monotonik koruma.
**Bitti kriteri:** 10 dakikalık `sleep` içeren run'da motor tamamen kapatılıp 10 dakika sonra açıldığında run hemen ilerliyor (sahte saatle). Vadesi geçmiş 500 timer açılışta doğru sırayla işleniyor.
**Commit:** `feat(core): durable timers and scheduler`

#### Gün 15: Zamanlanmış ve tekrarlayan workflow'lar

**Hedef:** Cron yeteneği.
**Kapsam:** `schedules` tablosu, cron ifade parse'ı, zaman dilimi desteği, overlap politikası (`skip`, `buffer_one`, `allow_all`), duraklat/devam et, geçmiş tetiklemeleri backfill.
**Bitti kriteri:** `*/5 * * * *` tanımı sahte saatle 1 saat ilerletildiğinde tam 12 run başlatıyor. `skip` politikasıyla önceki run bitmeden yenisi başlamıyor. Duraklatılan schedule hiç tetiklenmiyor.
**Commit:** `feat(core): cron schedules`

#### Gün 16: Signal ve query

**Hedef:** Çalışan run ile dışarıdan etkileşim.
**Kapsam:** `signalRun` API'si ve olay olarak kaydı, `ctx.waitForSignal(name)`, sinyal tamponlama (run henüz beklemiyorken gelen sinyal kaybolmaz), `ctx.select()` ile ilk tamamlanan bekleme, `queryRun` ile yan etkisiz anlık durum okuma.
**Bitti kriteri:** Beklemeye girmeden önce gönderilen sinyal, run beklemeye geçtiğinde teslim ediliyor. `select` iki bekleme arasından ilk tamamlanana dallanıyor ve replay'de aynı dalı seçiyor. Query çağrısı olay günlüğüne hiçbir şey yazmıyor.
**Commit:** `feat(core): signals, buffering and queries`

#### Gün 17: İptal ve compensation (saga)

**Hedef:** Geri alınabilir iş akışları.
**Kapsam:** `cancelRun` ve `terminateRun` ayrımı (graceful vs sert), cancellation scope'u ve alt adımlara yayılması, `ctx.onCancel()` ve compensation kaydı, iptal sırasında çalışan step'in beklenmesi, `CancelledError` semantiği.
**Bitti kriteri:** İptal edilen saga, kaydedilen compensation adımlarını ters sırayla çalıştırıp `CANCELLED` durumunda kapanıyor. `terminate` compensation çalıştırmadan anında `TERMINATED` yapıyor. İptal sonrası yeni step kuyruğa alınmıyor.
**Commit:** `feat(core): cancellation scopes and compensation`

#### Gün 18: Child workflow ve fan-out/fan-in

**Hedef:** Kompozisyon.
**Kapsam:** `ctx.startChild()` ve `ctx.executeChild()`, parent-child ilişkisi ve `parentClosePolicy`, paralel step'lerin deterministik `all` / `allSettled` karşılığı, çocuk sayısına üst sınır ve backpressure.
**Bitti kriteri:** 100 child içeren fan-out/fan-in run'ı doğru toplam sonuçla tamamlanıyor. Parent iptal edildiğinde `parentClosePolicy: cancel` olan çocuklar da iptal oluyor, `abandon` olanlar çalışmaya devam ediyor.
**Commit:** `feat(core): child workflows and parallel execution`

---

### FAZ 5: ÖLÇEK VE EVRİM (Gün 19-21)

#### Gün 19: continue-as-new ve history sıkıştırma

**Hedef:** Sonsuz çalışan workflow'ların history'sinin şişmemesi.
**Kapsam:** `ctx.continueAsNew(input)`, run zinciri ve `first_run_id` takibi, history boyut/olay sayısı eşiği ve uyarı, eski run'lar için snapshot yazımı ve olay budama (retention politikası ile).
**Bitti kriteri:** 10.000 iterasyonluk döngü workflow'u sabit bellek ve sabit history boyutuyla koşuyor. Zincirin tamamı tek `first_run_id` ile sorgulanabiliyor. Budama sonrası snapshot'tan replay doğru sonuç veriyor.
**Commit:** `feat(core): continue-as-new and history compaction`

#### Gün 20: Sticky execution ve replay cache

**Hedef:** Performans: her task'ta sıfırdan replay etmemek.
**Kapsam:** Worker başına run cache'i (LRU), sticky queue ile aynı run'ı aynı worker'a yönlendirme, cache miss'te tam replay'e düşme, sticky timeout ve cache invalidation.
**Bitti kriteri:** 500 adımlı bir workflow'da sticky cache açıkken toplam replay sayısı, kapalı durumun en az %80 altında (benchmark testi ile ölçülü). Cache kasten boşaltıldığında sonuç değişmiyor.
**Commit:** `feat(worker): sticky execution cache`

#### Gün 21: Workflow versiyonlama

**Hedef:** Çalışan run'lar bozulmadan kod değiştirebilmek.
**Kapsam:** `ctx.patched(patchId)` ve `ctx.deprecatePatch(patchId)`, patch kararlarının olay günlüğüne yazılması, worker build id damgası, versiyon uyumsuzluğunda güvenli reddetme, versiyon rehberi dokümanı.
**Bitti kriteri:** v1 kodu ile başlamış ve yarıda kalmış run'lar, v2 kodu devreye alındıktan sonra `NonDeterminismError` almadan tamamlanıyor (kayıtlı history fixture'ları ile kanıtlı). Yeni run'lar v2 dalını kullanıyor.
**Commit:** `feat(core): workflow versioning with patch gates`

---

### FAZ 6: ÜRÜN YÜZEYİ (Gün 22-26)

#### Gün 22: HTTP API ve kimlik doğrulama

**Hedef:** Motorun dışarıya açılması.
**Kapsam:** `startRun`, `signalRun`, `cancelRun`, `terminateRun`, `describeRun`, `listRuns`, `getHistory` uçları. API key auth, namespace izolasyonu (her sorguda zorunlu tenant filtresi), start için idempotency key, OpenAPI şeması üretimi.
**Bitti kriteri:** Namespace A'nın anahtarıyla namespace B'nin run'ına erişim 404 dönüyor (her uç için test). Aynı idempotency key ile iki `startRun` tek run yaratıyor. OpenAPI çıktısı şema doğrulamasından geçiyor.
**Commit:** `feat(api): rest endpoints with namespace isolation`

#### Gün 23: Kotalar, rate limit ve backpressure

**Hedef:** Kötü komşu problemini engellemek.
**Kapsam:** Namespace başına rate limit (token bucket), eşzamanlı run ve pending task kotaları, kota aşımında `429` ve `Retry-After`, kuyruk derinliğine göre worker poll backpressure'ı, poison pill koruması (aynı task N kez worker öldürürse karantina).
**Bitti kriteri:** Kotasını aşan namespace `429` alırken diğer namespace etkilenmeden çalışmaya devam ediyor. Worker'ı sürekli çökerten task 3 denemeden sonra karantinaya alınıyor ve kuyruğu bloke etmiyor.
**Commit:** `feat(api): quotas, rate limiting and poison pill protection`

#### Gün 24: Dağıtık izleme (tracing)

**Hedef:** Bir run'ın uçtan uca görünürlüğü.
**Kapsam:** OpenTelemetry entegrasyonu, workflow span'i altında step ve timer span'leri, trace context'in start çağrısından worker'a ve child workflow'lara taşınması, replay sırasında sahte span üretmeme, örnekleme (sampling) ayarı.
**Bitti kriteri:** Child workflow içeren bir run, Jaeger'da tek ve kopuksuz bir span ağacı olarak görünüyor (compose ile kurulu Jaeger üzerinde doğrulanmış). Replay edilen adımlar duplicate span üretmiyor.
**Commit:** `feat(observability): opentelemetry tracing`

#### Gün 25: Metrikler, loglar ve sağlık uçları

**Hedef:** Operasyona hazırlık.
**Kapsam:** Prometheus metrikleri (kuyruk derinliği, task latency histogramı, retry oranı, timer gecikmesi, aktif worker sayısı, run durum sayaçları), yapısal JSON loglar ve korelasyon id'leri, `/health` ve `/ready` uçları, örnek Grafana dashboard JSON'u.
**Bitti kriteri:** `/metrics` çıktısı Prometheus formatında parse ediliyor ve beklenen 8 metriği içeriyor (test ile). Postgres kapalıyken `/ready` 503, `/health` 200 dönüyor. Dashboard JSON'u repoda.
**Commit:** `feat(observability): metrics, structured logs and health probes`

#### Gün 26: Web UI

**Hedef:** İnsan gözüyle izlenebilirlik.
**Kapsam:** Run listesi (durum, namespace, tarih, workflow tipi filtreleri, sayfalama), run detayında zaman çizelgeli olay geçmişi, girdi/çıktı/hata görüntüleyici, SSE ile canlı güncelleme, UI üzerinden signal gönderme, iptal ve DLQ'dan yeniden kuyruğa alma.
**Bitti kriteri:** Çalışan bir workflow UI'da sayfa yenilemeden ilerlerken görülüyor, UI'dan gönderilen sinyalle dallanıyor ve UI'dan iptal edilebiliyor (Playwright ile uçtan uca test).
**Commit:** `feat(ui): run explorer with live updates`

---

### FAZ 7: SERTLEŞTİRME VE YAYIN (Gün 27-30)

#### Gün 27: Kaos testleri ve invariant denetleyici

**Hedef:** Doğruluğu kanıtlamak.
**Kapsam:** Fault injection suite: worker kill, DB bağlantı kopması ve geri gelmesi, çift teslimat, saat ileri/geri kaydırma, yavaş disk simülasyonu, ağ gecikmesi. Invariant checker: her run ya terminal ya ilerliyor, ack'lenmemiş task kaybolmuyor, step sonucu asla iki kez yazılmıyor, projeksiyon olay günlüğüyle tutarlı.
**Bitti kriteri:** 6 arıza senaryosunun her biri 10 tekrar koşuyor ve invariant ihlali sıfır. Rapor `docs/CHAOS_REPORT.md` dosyasına yazılıyor.
**Commit:** `test(chaos): fault injection suite and invariant checker`

#### Gün 28: Performans ölçümü ve ayar

**Hedef:** Sayılarla konuşmak.
**Kapsam:** Benchmark harness (saniyede başlatılan run, saniyede tamamlanan step, uçtan uca p50/p95/p99 gecikme), connection pool ve batch boyutu ayarı, sıcak sorgular için indeks gözden geçirme ve `EXPLAIN ANALYZE` kanıtları, olay yazımında batching.
**Bitti kriteri:** Tek node üzerinde ölçülmüş ve `docs/BENCHMARKS.md` dosyasına yazılmış taban değerler var. En az bir somut darboğaz tespit edilip düzeltilmiş ve iyileşme öncesi/sonrası sayı ile gösterilmiş.
**Commit:** `perf(core): query and batching optimizations`, `docs: benchmark results`

#### Gün 29: CLI ve örnek uygulamalar

**Hedef:** Geliştirici deneyimi.
**Kapsam:** CLI: `wf dev` (tek komutla Postgres + api + worker + ui), `wf worker`, `wf run start|signal|cancel|describe|list`, `wf migrate`. İki tam örnek: ödeme saga'sı (rezervasyon, tahsilat, compensation) ve ETL pipeline (fan-out ile batch işleme, retry, cron).
**Bitti kriteri:** Temiz makinede `npx wf dev` ile ortam ayağa kalkıyor ve her iki örnek tek komutla uçtan uca koşuyor. Örneklerin kendi testleri CI'da çalışıyor.
**Commit:** `feat(cli): developer commands`, `docs(examples): payment saga and etl pipeline`

#### Gün 30: Dokümantasyon, paketleme ve v0.1.0

**Hedef:** Yayınlanabilir ürün.
**Kapsam:** README (5 dakikalık hızlı başlangıç), `docs/ARCHITECTURE.md` (diyagramlı), `docs/CONCEPTS.md` (determinizm, versiyonlama, retry, idempotency), API referansı, üretim dağıtım notları, çok aşamalı Dockerfile ve yayınlanan image, `CHANGELOG.md`, semver etiketi `v0.1.0`, `docs/ROADMAP.md`.
**Bitti kriteri:** Repoyu ilk kez gören biri sadece README'yi takip ederek 5 dakikada bir workflow çalıştırabiliyor (adımlar temiz konteynerde doğrulanmış). `v0.1.0` tag'i ve release notu yayında.
**Commit:** `docs: architecture and concepts`, `chore(release): v0.1.0`

---

## BÖLÜM C: YEDEK GÖREV HAVUZU

Gün erken biterse sırayla buradan al, ertesi günün kapsamına dokunma.

1. Mevcut modülün test kapsamını ölç, en düşük kapsamlı dosyaya test yaz.
2. Property-based test ekle (fast-check) mevcut bir invariant için.
3. Public API'de eksik TSDoc yorumlarını tamamla.
4. `docs/CONCEPTS.md` içine bugün yazdığın mekanizmanın açıklamasını ekle.
5. Bir hata mesajını daha teşhis edilebilir hâle getir (bağlam, olası neden, çözüm önerisi).
6. CI süresini kısalt (cache, paralel job).
7. `docs/DECISIONS.md` içine bugünkü örtük kararları ADR olarak yaz.

## BÖLÜM D: RİSKLİ GÜNLER

Gün 5, 6, 12, 19, 21 ve 27 taşma riski en yüksek günlerdir. Bu günlerde kapsamı bölmek gerekirse çekirdek davranışı koru, ergonomiyi ve ek testleri `docs/DEFERRED.md` dosyasına ertele. Determinizm, crash recovery ve idempotency garantilerinden asla feragat etme.
