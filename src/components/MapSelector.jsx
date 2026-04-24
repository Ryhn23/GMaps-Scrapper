import React, { useEffect } from 'react';
import { MapContainer, TileLayer, Marker, Circle, useMapEvents, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';

// Fix for default marker icon in Leaflet
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';

let DefaultIcon = L.icon({
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
  iconSize: [25, 41],
  iconAnchor: [12, 41]
});
L.Marker.prototype.options.icon = DefaultIcon;

// Helper component to handle external movements
const MapController = ({ center }) => {
  const map = useMap();
  useEffect(() => {
    if (center) {
      map.flyTo(center, 15);
    }
  }, [center, map]);
  return null;
};

const MapSelector = ({ center, radius, onLocationSelect }) => {
  function LocationMarker() {
    const map = useMapEvents({
      click(e) {
        onLocationSelect(e.latlng);
        map.flyTo(e.latlng, map.getZoom());
      },
    });

    return center ? (
      <>
        <Marker position={center} />
        <Circle 
          center={center} 
          radius={radius} 
          pathOptions={{ color: '#000000', fillColor: '#000000', fillOpacity: 0.1, weight: 1 }}
        />
      </>
    ) : null;
  }

  return (
    <MapContainer 
      center={center || [-6.2088, 106.8456]} 
      zoom={13} 
      style={{ height: '100%', width: '100%' }}
    >
      <TileLayer
        attribution='&copy; Google Maps'
        url="https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}"
      />
      <MapController center={center} />
      <LocationMarker />
    </MapContainer>
  );
};

export default MapSelector;
