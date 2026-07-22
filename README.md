# Travel

Planificador de vacaciones: creá varios viajes (nombre, fechas y ciudad base) y organizá el itinerario de cada uno con mapa y calendario.

Lives at **[travel.42.uy](https://travel.42.uy)**.

## How it works

Cada viaje tiene un nombre, fechas de inicio y fin, y una ciudad base donde aterrizás. Un mapa (OpenStreetMap) muestra las paradas del viaje en orden cronológico; al tocar una parada o su tarjeta se dibuja la ruta desde la base con distancia y tiempo estimado en auto. Debajo del mapa, el itinerario lista cada parada como un ticket: título, tipo (viaje, museo, fotos, comida), fechas, descripción y fotos; también hay vista de calendario acotada a las fechas del viaje. Desde el encabezado se cambia entre viajes o se borra uno. Todo se guarda localmente en el dispositivo, con deshacer/rehacer y exportación/importación a JSON. Funciona como PWA instalable en iPhone; solo los tiles del mapa requieren conexión.

## License

[MIT](./LICENSE) — Copyright (c) 2026 Santiago Ferreira.
