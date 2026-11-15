# Servis Takip

Okul servisinin **eve kaç dakikada geleceğini** ve **okula ne zaman varacağını** velilerin
telefondan takip edebildiği sistem.

## Ekranlar

| Ekran | Adres | Kim kullanır |
|---|---|---|
| Veli ekranı | `/v/<veli-linki>` | Veli: kalan dakika, harita, bildirimler, "bugün gelmeyecek" |
| Şoför ekranı | `/d/<şoför-linki>` | Şoför: tur başlat/bitir, telefondan konum gönderir |
| Yönetim | `/admin` | Firma: servis, öğrenci, okul tanımları, canlı harita, linkleri WhatsApp ile gönderme |

Her veliye kendi çocuğuna özel tahmin edilemez bir link verilir. Uygulama indirmek gerekmez.
Link başkasına geçerse yönetimden "Linki yenile" ile eskisi iptal edilir.

## Çalıştırma

Node.js 22.13 veya üstü gerekir.

```bash
npm install
npm run demo        # demo verisi (1 okul, 2 servis, 10 öğrenci) ekler ve başlatır
```

`http://localhost:3000/admin` (kullanıcı `admin`, şifre `ADMIN_PASSWORD`) →
Canlı sekmesinde "Sabah simülasyonu" ile sahte bir servis yürütülür; Öğrenciler sekmesinden
"Aç" ile veli ekranını görebilirsiniz.

```bash
npm test            # internet gerektirmez
```

## Ayarlar (ortam değişkenleri)

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `PORT` | 3000 | |
| `ADMIN_USER` / `ADMIN_PASSWORD` | admin / admin | **Canlıda mutlaka değiştirin** |
| `DB_FILE` | `data/servis.db` | SQLite dosyası |
| `ROUTING` | `osrm` | `osrm` (yol ağına göre) veya `simple` (kuş uçuşu × 1.35) |
| `OSRM_URL` | `https://router.project-osrm.org` | Ücretsiz demo sunucu; kalıcı kullanımda kendi OSRM sunucumuz önerilir |
| `TILE_URL` | OpenStreetMap | Harita görselleri |
| `STOP_DWELL_SEC` | 45 | Her durakta ortalama bekleme |
| `ARRIVE_RADIUS_M` | 60 | Durağa varıldı sayılma mesafesi |
| `NEAR_NOTIFY_MIN` | 5 | "Servis X dk sonra evinizde" bildirimi |
| `SIM_SPEEDUP` | 8 | Simülatör hız çarpanı |
| `EXTERNAL_API_URL` / `EXTERNAL_API_KEY` / `EXTERNAL_POLL_SEC` | – | Mevcut takip programının API'si |

## Süre nasıl hesaplanıyor?

1. Tur başlarken servisin konumundan başlayıp sıradaki tüm evlerden (ve sabah okuldan) geçen
   rota **bir kez** OSRM'den alınır. OSRM'e ulaşılamazsa basit tahmine düşer.
2. Servisten gelen her konum bu rotanın üzerine izdüşürülür; her durak için kalan süre
   = rotadaki kalan yol süresi + önündeki öğrenci sayısı × durak bekleme süresi.
3. Servis bir eve 60 m yaklaşınca o durak tamamlanır, veliye bildirim gider.
4. Servis rotadan 250 m'den fazla saparsa kalan duraklar için rota yeniden hesaplanır.
5. "Bugün gelmeyecek" denirse o ev turdan çıkarılır, diğer velilerin süresi kısalır.

Harita servisine sürekli istek atılmadığı için ücretsiz servisler yeterli.

## Konum kaynakları

- **Şoför telefonu** (`/d/...` sayfası): Tur boyunca sayfa açık kalmalı.
- **Mevcut takip programı**: `src/providers/external-api.js`. API belgeleri gelince
  `parseVehicles` cevap formatına göre uyarlanacak; yönetimde her servise
  "Takip programındaki araç no" girilecek.
- **Simülatör**: Demo ve test için.

## Gizlilik (KVKK)

- Veli yalnızca kendi çocuğunun evini, okulu ve servisi görür; diğer öğrencilerin adı,
  adresi ve servis rotası gösterilmez (sadece "sizden önce 2 öğrenci alınacak").
- Servisin konumu yalnızca tur sırasında gösterilir.
- Canlıya çıkmadan önce velilerden açık rıza metni alınmalı.

## Yapılacaklar

- [ ] Mevcut takip programının API'sini bağlamak
- [ ] Gerçek push bildirimi (Web Push / uygulama): şu an bildirimler sayfa açıkken geliyor
- [ ] Firma bazlı ayrım (her servisçi kendi panelini görsün) – çok müşteriye satış için
- [ ] Trafik verisi (ücretli harita servisi) gerekirse
- [ ] Sunucuya kurulum (HTTPS zorunlu: tarayıcı konum ve bildirim izni için)
