'use client';

import { useEffect } from 'react';
import { AdvancedMarker, APIProvider, Map, Pin, useMap } from '@vis.gl/react-google-maps';
import { CITY_ZOOM, type MapView, type PinCoords } from '@/lib/map_view';

/**
 * The Google map behind {@link MapPinPicker}, used when the portal is built
 * with a Google Maps browser key. One map load is billed per mount (Dynamic
 * Maps; free up to Google's monthly allowance).
 */
export function GooglePinMap({
  apiKey,
  mapId,
  coords,
  initialView,
  unpinnedView,
  onPick,
}: {
  apiKey: string;
  /** Needed for the draggable marker; created in the Google Cloud console. */
  mapId: string;
  coords: PinCoords | null;
  initialView: MapView;
  /** Where to look while there's no pin. */
  unpinnedView: MapView | null;
  onPick: (c: PinCoords) => void;
}) {
  return (
    <APIProvider apiKey={apiKey}>
      <Map
        className="h-64 w-full overflow-hidden rounded-[var(--radius)] border border-[#e5e7eb]"
        style={{ minHeight: '16rem' }}
        mapId={mapId}
        defaultCenter={{ lat: initialView.lat, lng: initialView.lng }}
        defaultZoom={initialView.zoom}
        // Scrolling the page over the map scrolls the page, as with the old map.
        gestureHandling="cooperative"
        clickableIcons={false}
        streetViewControl={false}
        mapTypeControl={false}
        fullscreenControl={false}
        onClick={(e) => {
          const p = e.detail.latLng;
          if (p) onPick({ lat: p.lat, lng: p.lng });
        }}
      >
        {coords && (
          <AdvancedMarker
            position={{ lat: coords.lat, lng: coords.lng }}
            draggable
            onDragEnd={(e) => {
              const p = e.latLng;
              if (p) onPick({ lat: p.lat(), lng: p.lng() });
            }}
          >
            <Pin background="#6390cc" borderColor="#4f7ab3" glyphColor="#ffffff" />
          </AdvancedMarker>
        )}
        <FollowView coords={coords} unpinnedView={unpinnedView} />
      </Map>
    </APIProvider>
  );
}

/** Moves the view: to the typed city / country while there's no pin, and
 *  back to a pin placed out of sight (without fighting a drag in progress). */
function FollowView({ coords, unpinnedView }: { coords: PinCoords | null; unpinnedView: MapView | null }) {
  const map = useMap();
  const lat = coords?.lat;
  const lng = coords?.lng;

  useEffect(() => {
    if (!map || lat !== undefined || !unpinnedView) return;
    map.setCenter({ lat: unpinnedView.lat, lng: unpinnedView.lng });
    map.setZoom(unpinnedView.zoom);
  }, [map, lat, unpinnedView]);

  useEffect(() => {
    if (!map || lat === undefined || lng === undefined) return;
    if (map.getBounds()?.contains({ lat, lng }) === false) {
      map.setCenter({ lat, lng });
      map.setZoom(Math.max(map.getZoom() ?? CITY_ZOOM, CITY_ZOOM));
    }
  }, [map, lat, lng]);

  return null;
}
