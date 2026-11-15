# Sunucuya kurulum (Railway)

Program, internetten erişilebilen ve **HTTPS** olan bir sunucuda çalışmalı. Telefon bildirimi ve
şoför konumu HTTPS olmadan çalışmaz. Önerilen yer **Railway**:
- GitHub'a her yükleme yaptığımızda otomatik güncellenir, velilerin bir şey yapması gerekmez
- HTTPS'li adres kendiliğinden gelir (`xxx.up.railway.app`)
- Aylık yaklaşık 5 dolar (Hobby planı) bu boyuttaki bir iş için yeter

> Railway'in ekranları zamanla değişebilir; düğme adları biraz farklı olabilir.

## 1. Hesap aç
1. https://railway.com adresine gir, **GitHub ile giriş yap**.
2. Hobby planını seç (kart bilgisi ister).

## 2. Projeyi oluştur
1. **New Project → Deploy from GitHub repo** → `servis-program-` deposunu seç.
   (Railway'e depoya erişim izni vermen istenir.)
2. Servis oluşunca **Settings → Source** kısmından dalı (branch) seç:
   şimdilik `claude/epic-brown-g3pxhw`. İleride `main`'e birleştirirsek onu seçeriz.
3. Railway depodaki `Dockerfile`'ı kendisi bulur ve kurar.

## 3. Kalıcı disk ekle (çok önemli)
Diski eklemezsen her güncellemede **tüm öğrenci ve yoklama kayıtları silinir**.
1. Servise sağ tıkla (veya Ctrl+K) → **Add Volume** (Disk ekle).
2. Bağlama yolu (Mount path): `/data`

## 4. Ayarları gir
Servis → **Variables** sekmesi:

| Değişken | Değer |
|---|---|
| `ADMIN_USER` | kendi yönetici kullanıcı adın (ör. `patron`) |
| `ADMIN_PASSWORD` | **güçlü bir şifre** (en az 12 karakter) |
| `VAPID_SUBJECT` | `mailto:` + iletişim e-postan (bildirim servisleri ister) |

`DB_FILE` ve `PORT` ayarlarına gerek yok, kendiliğinden doğru gelir.

## 5. Google Haritalar (canlı kullanım için)

Harita görüntüsü, **canlı trafiğe göre** varış süresi ve adres arama Google ile çalışır.
Anahtar girilmezse program ücretsiz haritayla (trafiksiz) çalışmaya devam eder.

### 5a. Google Cloud hesabı
1. https://console.cloud.google.com → yeni proje: `servis-takip`.
2. **Faturalandırma (Billing)** hesabı bağla (kart gerekir).
3. **APIs & Services → Library** kısmından şu üçünü etkinleştir:
   - **Maps JavaScript API** (harita görüntüsü)
   - **Routes API** (trafiğe göre süre)
   - **Places API (New)** (yönetim panelinde adres arama)

### 5b. İki ayrı anahtar oluştur (APIs & Services → Credentials → Create API key)

| Anahtar | Kısıtlama (mutlaka yapın) | Railway değişkeni |
|---|---|---|
| **Sunucu anahtarı** | API kısıtlaması: sadece *Routes API* | `GOOGLE_MAPS_SERVER_KEY` |
| **Tarayıcı anahtarı** | Uygulama kısıtlaması: *Websites* → `https://ALAN-ADINIZ/*` · API kısıtlaması: *Maps JavaScript API* ve *Places API (New)* | `GOOGLE_MAPS_BROWSER_KEY` |

Tarayıcı anahtarı velilerin telefonuna gider, yani herkes görebilir. Bu yüzden **sadece kendi alan
adımızda çalışacak şekilde kısıtlanmalı**, yoksa başkası kullanıp faturayı bize yazdırabilir.

### 5c. Harita kimliği (Map ID)
**Google Maps Platform → Map Management → Create Map ID** (tür: JavaScript, Vector).
Çıkan kimliği `GOOGLE_MAPS_MAP_ID` değişkenine yaz.

### 5d. Bütçe sınırı (unutmayın)
- **Billing → Budgets & alerts**: aylık bütçe (ör. 50 $) ve %50 / %90 / %100 e-posta uyarısı.
- **APIs & Services → Routes API → Quotas**: günlük istek sınırı (ör. günde 1.000).
  Bir hata olursa fatura kontrolden çıkmaz.

### Tahmini maliyet (7 servis, ~120 veli)
Google'ın Kasım 2026 fiyat listesine göre; her ürünün aylık ücretsiz kotası var:

| Kalem | Kullanım tahmini | Ücretsiz kota / fiyat | Aylık |
|---|---|---|---|
| Routes (trafikli süre) | tur başına ~15 istek (3 dk'da bir yenileme) × 7 servis × 2 tur × 22 gün ≈ 4.600 | 5.000 ücretsiz, sonra 1.000 istek 10 $ | ~0–10 $ |
| Harita görüntüleme | veli sayfayı günde ~4 kez açar: 120 × 4 × 22 ≈ 10.500 | 10.000 ücretsiz, sonra 1.000 açılış ~7 $ | ~0–15 $ |
| Adres arama | sadece öğrenci eklerken | çok düşük | ~0 $ |

**Toplam: ayda yaklaşık 0–30 $.** Servis sayısı arttıkça doğru orantılı artar.
Maliyeti düşürmek için `ROUTE_REFRESH_SEC` (varsayılan 180 sn) büyütülebilir.

## 6. Adres al
**Settings → Networking → Generate Domain**. Sana `https://xxx.up.railway.app` gibi bir adres verir.
İleride kendi alan adını (ör. `servisim.com`) da buraya bağlayabiliriz.

## 7. Dene
1. `https://xxx.up.railway.app/login` → süper yönetici olarak gir.
2. **Firmalar** sekmesinden bir test firması ekle, o firmanın paneline geç.
3. Okul, servis ve bir öğrenci ekle (öğrencinin evi olarak kendi evini seç).
4. Öğrenciler sekmesinde **Veli linki**'ni kopyala, kendi telefonunda aç:
   - Android: "Telefonuma bildirim gelsin"e bas, izin ver.
   - iPhone: Safari'de **Paylaş → Ana Ekrana Ekle**, ana ekrandaki simgeden aç, sonra izin ver.
5. Canlı sekmesinden **Sabah simülasyonu**'nu başlat, telefonu kilitle ve bildirimlerin gelip gelmediğine bak.

## Güncellemeler
GitHub'a yeni kod yüklendiğinde Railway birkaç dakika içinde kendiliğinden yeni sürümü kurar.
Veliler bir sonraki açışta yeni hâli görür; linkler ve bildirim izinleri değişmez.

## Yedek
Railway → Volume → **Backups** kısmından düzenli yedek almayı aç. Tüm veriler `/data/servis.db`
dosyasındadır.
