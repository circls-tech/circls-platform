'use client';

import {
  useDeleteEventImage,
  useEventImages,
  useReorderEventImages,
  useSetEventImageFocal,
  useUploadEventImage,
} from '@/lib/api/queries';
import { ImageGalleryEditor } from './ImageGalleryEditor';

const MAX_IMAGES = 12;

/**
 * Event photo gallery for the partner portal. Same flow as VenueImages:
 * presigned PUT straight to R2, public-URL reads. All of the gallery UI lives
 * in ImageGalleryEditor; this only binds the event-flavoured hooks.
 */
export function EventImages({ eventId }: { eventId: string }) {
  const { data: images, isLoading } = useEventImages(eventId);
  const upload = useUploadEventImage(eventId);
  const del = useDeleteEventImage(eventId);
  const reorder = useReorderEventImages(eventId);
  const focal = useSetEventImageFocal(eventId);

  return (
    <ImageGalleryEditor
      subject="event"
      images={images}
      isLoading={isLoading}
      max={MAX_IMAGES}
      hint="recurring dates share this gallery"
      uploadFile={(file) => upload.mutateAsync(file)}
      deleteImage={(imageId) => del.mutateAsync(imageId)}
      reorder={(imageIds) => reorder.mutateAsync(imageIds)}
      setFocal={(imageId, f) => focal.mutateAsync({ imageId, focal: f })}
    />
  );
}
