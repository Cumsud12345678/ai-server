# car-advisor (çoxmüştərili AI elan məsləhətçisi)

## Quraşdırma
1. `npm install`
2. `.env.example` → `.env` kopyala, `GEMINI_API_KEY`-i yaz
3. Test: `npm test` (Gemini və DB tələb etmir)

## Sınaq (3 terminal)
```
npm run mock     # saxta müştəri API-si (port 4000)
npm start        # əsas server (port 3000)
```
Postman (Authorization: Bearer ...) , hazır inkişaf açarları (yalnız lokal!):
| Müştəri | Açar | Mənbə |
|---|---|---|
| demo-sample | ck_dev_sample | nümunə data |
| demo-musteri | ck_dev_musteri | saxta müştəri API-si (fərqli sxem) |
| own-site | ck_dev_own | real MongoDB (.env-də MONGODB_URI) |

- `POST /v1/chat`      body: `{ "message": "...", "history": [] }` → `{ answer, listings, usage }`
- `GET  /v1/listings?maxPrice=10000&make=BMW`  (AI olmadan, debug)
- `GET  /v1/usage`
- `GET  /health`

## Yeni müştəri əlavə etmək
1. `node scripts/new-key.mjs` → açar və hash. Açarı müştəriyə ver, hash-i konfiqurasiyaya yaz.
2. `src/tenants/tenants.json`-a yeni obyekt əlavə et (`demo-musteri` nümunədir):
   `source.filters` (filtr → müştərinin parametri), `source.response.fields` (cavab sahəsi → standart sahə),
   `source.vocabulary` (ad ↔ ID siyahıları), `profile` (ad, ton, dil, əlavə qaydalar), `limits`.
3. Müştərinin API açarını `.env`-ə yaz (`auth.valueEnv` adı ilə), heç vaxt tenants.json-a yox.
4. `npm run try:connector -- <tenantId> '{"maxPrice":15000,"make":"BMW"}'` ilə yoxla: göndərilən sorğu, xam cavab, çevrilmiş nəticə, boş sahələr.
5. 20-30 test sualı ilə `/v1/chat`-i yoxla.

## Konfiqurasiya qaydaları (response.fields)
- `"price": "price.value"` : yol. `"title": "{brand.title} {model.title?}"` : şablon ({x} məcburi, {x?} könüllü, `{x|slug}`).
- `{ "path": "category.code", "lookup": "bodyType" }` : ID/kodu vocabulary ilə ada çevirir.
- Rəqəm sahələri mətn gəlsə də ("12 500") avtomatik çevrilir.
- `itemFilter`: müştərinin qaytardığı lazımsız elanları (qaralama) atır.
- `"divide": 100` / `"multiply": 2`: rəqəm sahəsini çevirir (qiymət sentlə gəlirsə `{ "path": "cents", "divide": 100 }`). 2 onluq işarəyə yuvarlanır.
- `"stripHtml": true`: sahədəki HTML etiketlərini və entity-ləri təmizləyir (şablonda `{desc|striphtml}`).
- `source.localText: true`: API mətn axtarışını bilmirsə, `text` filtrinin sözləri nəticələrdə (başlıq, marka, model, şəhər, xüsusiyyətlər) lokal yoxlanır. Qeyd: yalnız API-nin qaytardığı səhifə daxilində süzür.
- GraphQL: `source.search.graphql` ("query($q:String){...}") yazılsa sorğu POST gedir, filtrlər `variables`-a düşür; `itemsPath` məs. `data.ads.nodes`. GraphQL `errors` qayıtsa aydın xəta verilir.

## Filtrlər (müştəri özü elan edir)
**Hər filtr eyni formada yazılır**: `{ "type", "description", "param" }` (aralıq üçün `minParam`/`maxParam`). "Hazır" filtr yoxdur:
`maxPrice`, `make` və başqaları da tam yazılır. Yalnız bir qayda var: qiymət filtrləri `minPrice`/`maxPrice` adı ilə, marka `make`,
model `model` adı ilə yazılsa, sistem onları qiymətə görə yerli yoxlama və s. üçün tanıyır. AI yalnız elan olunmuş filtrləri görür
(maksimum 15; çox olsa AI qarışır). Sxemdə olmayan açar heç vaxt müştəri API-sinə getmir.
Səhifə ölçüsü filtr deyil: `source.search.limitParam` ilə yazılır (köhnə `filters.limit.param` də işləyir).
Köhnə saxlanmış müştərilərdə qısa yazılış (`"maxPrice": { "param": "p" }`) işləməyə davam edir, amma yeni/yenilənən konfiqurasiyada
`type` və `description` məcburidir (panel köhnəni avtomatik tam formaya çevirir).

```json
"filters": {
  "color":    { "type": "string",  "description": "Rəng", "param": "color", "values": ["Qara", "Ağ"] },
  "year":     { "type": "range",   "description": "Buraxılış ili", "minParam": "year_from", "maxParam": "year_to" },
  "warranty": { "type": "boolean", "description": "Zəmanəti var", "param": "warranty", "valueMap": { "true": "1", "false": "0" } },
  "tags":     { "type": "multi",   "description": "Etiketlər", "param": "tags", "values": ["a", "b"], "separator": "," }
}
```
- `type`: `string`, `number`, `boolean`, `multi` (siyahı), `range` (AI-a `<ad>Min` / `<ad>Max` kimi görünür).
- `description` məcburidir: AI filtri bununla başa düşür. `values` verilsə AI yalnız bu dəyərlərdən seçə bilər.
- `valueFrom: "vocabulary"` (string/multi): ad müştərinin siyahısı ilə ID-yə çevrilir; siyahının açarı filtrin adı ilə eyni olmalıdır.
- `valueMap`: dəyər çevirməsi (məs. `true → "1"`). `format: "array"` (multi): POST gövdəsində massiv göndərir.
- Əlavə nəticə sahələri `response.fields.attributes` ilə (`"Rəng": "color.title"`) gəlir, AI və kartlar onları görür.
- `localSort`: `true` və ya `["price","year"]` (müştəri API-si sıralamanı bilmirsə, bizdə sıralanır).
- Köhnə hazır adlar (`bodyType`, `city`, `fuelType`, `transmission`, `minYear`, `maxYear`, `maxMileage`) `type` olmadan işləyir,
  yeniləri üçün `type` və `description` yaz.

## Müştərilərin və sayğacın saxlanması (MongoDB)
`.env`-də `AI_MONGODB_URI` (və istəsən `AI_MONGODB_DB`, defolt `car_advisor_ai`) yazılıbsa, müştərilər `tenants`, aylıq sorğu/token sayğacı `usage` kolleksiyasında saxlanır. Yazılmayıbsa, yalnız inkişaf üçün fayllar (`data/customer-tenants.json`, `data/usage.json`) işlənir.
- Aylıq limit atomik sayılır (`$inc`): eyni anda gələn sorğular bir-birinin sayını silmir. Dəqiqəlik limit hər serverin yaddaşındadır.
- Müştəri siyahısı server yaddaşında saxlanır və hər 30 saniyədən bir DB-dən yenilənir (çoxlu server olsa, dəyişiklik ən çox 30 saniyəyə görünür).
- Köhnə fayllardakı məlumatı köçürmək: `node scripts/migrate-to-db.mjs --dry` (nəyin köçüləcəyini göstərir), sonra `node scripts/migrate-to-db.mjs`. Təkrar işlətmək təhlükəsizdir, fayllar silinmir.
- Mongo rejimində `TENANT_SECRET_ENCRYPTION_KEY` **eyni** qalmalıdır: müştərilərin API sirləri bununla şifrələnib.

## Təhlükəsizlik
- API açarları hash-lə saxlanır; `devOnly` müştərilər `NODE_ENV=production` olanda yüklənmir.
- Müştəri URL-ləri üçün SSRF qoruması: yalnız https, daxili IP-lər bloklanır, redirect yoxdur, timeout və ölçü limiti.
  Məhdudiyyət: DNS yoxlaması ilə sorğu arasında DNS dəyişikliyi (rebinding) ehtimalı qalır; production-da server
  şəbəkəsində daxili ünvanlara çıxışı (egress) firewall ilə də bağla.
- Telefon və satıcı məlumatı heç bir mənbədən çıxmır (standart formata daxil deyil).
- Sayğac fayl əsaslıdır (`data/usage.json`, bir proses); çox serverdə DB-yə köçür.


## Portal backend-i ilə əlaqə (müştəri qoşulması)

Müştəri qeydiyyatı, giriş və konfiqurasiya yükləmə artıq bu serverdə deyil: bunlar ayrıca **portal backend-indədir** (hesablar, parol, email təsdiqi). Bu server yalnız konfiqurasiyanı yoxlayıb tenant yaradır. Köhnə `/onboarding` səhifəsi və `/v1/onboarding*`, `/v1/admin/onboarding*` endpoint-ləri silinib.

### Hazırlıq

1. `.env`-ə `SERVICE_TOKEN` (uzun təsadüfi dəyər; köhnə adı `ONBOARDING_ADMIN_TOKEN` də işləyir) və `TENANT_SECRET_ENCRYPTION_KEY` (64 hex simvol) əlavə et. Generasiya: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
2. Eyni `SERVICE_TOKEN` dəyərini portal backend-inin `.env`-ində `AI_SERVICE_TOKEN` kimi yaz.
3. Bu server internetə açıq olmamalıdır: yalnız portal backend-i və müştərilərin öz backend-ləri çatmalıdır. Production-da HTTPS istifadə et.

### Servis endpoint-ləri (`Authorization: Bearer <SERVICE_TOKEN>`)

- `POST /v1/service/config/test` — konfiqurasiyanı yoxlayır və müştərinin API-sinə real sorğu göndərir (heç nə yaratmır).
- `POST /v1/service/tenants` — yoxlamadan keçərsə müştərini aktivləşdirir, API açarı cavabda **yalnız bir dəfə** qaytarılır. Heç olmasa 1 elan düzgün oxunmalıdır, əks halda `422`.
- `PUT /v1/service/tenants/:tenantId/config` — konfiqurasiyanı yeniləyir (açar dəyişmir; `apiSecret` göndərilməsə köhnə sirr saxlanır).
- `PATCH /v1/service/tenants/:tenantId/profile` — dil, ton, `maxResults`, əlavə təlimat.
- `POST /v1/service/tenants/:tenantId/rotate-key` — yeni açar; köhnə açar dərhal etibarsız olur.
- `POST .../chat`, `GET .../listings`, `GET .../usage` — müştərinin açarını bilmədən, tenantId ilə (portalın sınaq söhbəti və istifadə səhifəsi üçün). Söhbət aylıq limitdən sayılır.

Müştərinin öz saytı isə əvvəlki kimi `/v1/chat`, `/v1/listings`, `/v1/usage` endpoint-lərini **müştəri API açarı** ilə çağırır.

### Konfiqurasiya formatı

```json
{
  "businessName": "Mənim avto saytım",
  "domain": "example.com",
  "apiSecret": "MUSTERI_API_ACARI",
  "profile": { "language": "az", "tone": "dostcasına", "maxResults": 5 },
  "source": { "type": "rest", "baseUrl": "https://api.example.com", "search": { "method": "GET", "path": "/api/listings" }, "filters": { "maxPrice": { "type": "number", "description": "Maksimum qiymət", "param": "price_to" } }, "response": { "itemsPath": "data.items", "fields": { "id": "id", "title": "title", "price": "price" } }, "auth": { "type": "header", "name": "X-Api-Key" } }
}
```

`customer-config.example.json` tam nümunədir. `apiSecret` yalnız `auth.type` `header`, `bearer` və ya `query` olanda lazımdır; şifrələnərək diskdə saxlanır (şifrələmə açarı itərsə, sirri açmaq mümkün olmaz). `valueEnv` və `encryptedValue` göndərmək qadağandır.

### Təhlükəsizlik və MVP məhdudiyyətləri

- Qeydiyyat açıqdır və yoxlamadan keçən konfiqurasiya avtomatik aktiv olur: hər təsdiqlənmiş email defolt olaraq aylıq 500 AI sorğusu alır (`DEFAULT_MONTHLY_REQUESTS`, `DEFAULT_RATE_PER_MINUTE`). Gemini xərcini bu limitlə idarə et.
- Xarici API ünvanlarına sorğular mövcud SSRF qorumasından keçir; lokal HTTP ünvanları yalnız `ALLOW_LOCAL_CONNECTORS=1` ilə development üçündür.
- Tenant-lar `data/customer-tenants.json` faylında saxlanır (bir server prosesi). Bir neçə replica üçün DB-yə köçür.

## Müştəriyə məxsus məlumat (sifariş, ödəniş, sorğu, şikayət, abunə və s.)

Saytın hesabına daxil olmuş istifadəçisi çatdan öz məlumatını soruşa bilər. Məlumat növlərini (`sources`) müştəri özü təyin edir.

- Kimliyi yalnız saytın serveri təsdiqləyir: `v1.<payload>.<HMAC-SHA256>` tokeni (`{sub, exp}`, ömrü ≤ 1 saat), gizli açar `POST /v1/service/tenants/:id/private-data/identity-secret` ilə bir dəfə verilir.
- Bir alət: `get_my_data({ type, id? })`. `type` yalnız təyin edilmiş növlərdən biri ola bilər, istifadəçi ID parametri yoxdur: ID yalnız yoxlanmış tokendən gəlir. Token yoxdursa alət modelə verilmir.
- `PUT .../private-data`: `{ baseUrl, auth, apiSecret, sources: [{ key, title, description, path ({userId} və ya userParam), itemsPath, fields: { "Ad": "yol" | { path, type: text|number|date|url, divide, max } }, idField?, ownerField?, lines? }] }`. Ən çox 10 növ, növ başına 20 sahə. Açar şifrələnir (`TENANT_SECRET_ENCRYPTION_KEY`).
- `ownerField` verilsə, sahibi uyğun gəlməyən sətirlər atılır (müştəri API-si səhv edərsə sızma olmasın).
- Cavab ≤ 10 qeyd, yalnız təyin edilmiş sahələr, mətn təmizlənir, e-poçt və uzun rəqəmlər maskalanır; şəxsi cavab keşə və sorğu qeydinə düşmür.
- Limit: sorğuda ≤ 3 çağırış, istifadəçi başına 10 dəqiqədə `PRIVATE_LOOKUPS_PER_10MIN` (defolt 20).
