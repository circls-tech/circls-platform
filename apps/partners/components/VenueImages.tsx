'use client';

import {
  useDeleteVenueImage,
  useReorderVenueImages,
  useSetVenueImageFocal,
  useUploadVenueImage,
  useVenueImages,
} from '@/lib/api/queries';
import { ImageGalleryEditor } from './ImageGalleryEditor';

const MAX_IMAGES = 12;

/**
 * Venue photo gallery for the partner portal. Uploads go straight to R2 via
 * presigned PUT (see useUploadVenueImage); reads use the public URL. All of the
 * gallery UI lives in ImageGalleryEditor; this only binds the venue hooks.
 */
export function VenueImages({ venueId }: { venueId: string }) {
  const { data: images, isLoading } = useVenueImages(venueId);
  const upload = useUploadVenueImage(venueId);
  const del = useDeleteVenueImage(venueId);
  const reorder = useReorderVenueImages(venueId);
  const focal = useSetVenueImageFocal(venueId);

  return (
    <ImageGalleryEditor
      subject="venue"
      images={images}
      isLoading={isLoading}
      max={MAX_IMAGES}
      uploadFile={(file) => upload.mutateAsync(file)}
      deleteImage={(imageId) => del.mutateAsync(imageId)}
      reorder={(imageIds) => reorder.mutateAsync(imageIds)}
      setFocal={(imageId, f) => focal.mutateAsync({ imageId, focal: f })}
    />
  );
}
