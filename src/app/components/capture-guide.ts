import { Component, input } from '@angular/core';
import type { ProjectKind } from '../../shared/models';

/** What makes photos and video reconstruct well, shown next to the uploader. */
@Component({
  selector: 'app-capture-guide',
  template: `
    <details class="guide">
      <summary>
        How to shoot {{ kind() === 'exterior' ? 'drone exteriors' : 'interiors' }} that reconstruct
        well
      </summary>

      <h3>The one rule: every spot seen from several places</h3>
      <p>
        Photogrammetry measures depth by spotting the same detail in photos taken from
        <em>different positions</em>. Turning on the spot gives no depth. Move the camera between
        shots and keep 60–80% overlap with the previous one. Each surface should appear in at least
        3 photos (5+ is better).
      </p>

      @if (kind() === 'exterior') {
        <h3>Drone flight</h3>
        <ul>
          <li>
            Fly 2–3 orbits around the house at different heights and distances, gimbal at about 30°
            and 60° down. Point the camera at the house the whole way round.
          </li>
          <li>Add a top-down lawnmower grid over the roof for print-ready tops.</li>
          <li>
            Fly slowly and smoothly; fast yaw or sudden climbs break the chain between frames. Slow
            sections reconstruct best.
          </li>
          <li>
            Finish low passes (2–4 m up) along each wall for detail under eaves, porches and decks.
          </li>
          <li>Hover-and-spin shots and take-offs add little; trim them if they're long.</li>
        </ul>
      } @else {
        <h3>Moving through rooms</h3>
        <ul>
          <li>
            Walk along the walls with the camera pointing across the room, then do a second lap at
            a different height (chest and knee).
          </li>
          <li>
            Never just pivot in the middle of a room. Step sideways between shots instead (about one
            step per photo).
          </li>
          <li>
            Shoot corners from both sides, and capture through each doorway on the way out so rooms
            link together.
          </li>
          <li>
            Plain walls and ceilings have nothing to match. Keep some furniture, trim, art or a
            window frame in every shot.
          </li>
        </ul>
      }

      <h3>Camera settings</h3>
      <ul>
        <li>Sharp beats everything: fast shutter (1/250 s+ when moving), no motion blur.</li>
        <li>Lock exposure, white balance and focus if you can, and keep the zoom fixed.</li>
        <li>
          Use the main (1×) lens. Ultra-wide and fisheye lenses work less well, and digital zoom or
          portrait/night modes alter the image.
        </li>
        <li>Keep stabilisation on for video; turn off HDR effects and beauty filters.</li>
        <li>Higher resolution helps, but sharpness and overlap matter more than megapixels.</li>
      </ul>

      <h3>Light and conditions</h3>
      <ul>
        <li>
          Even light is ideal: overcast days outside, every lamp on inside. Hard sun gives black
          shadows and blown highlights.
        </li>
        <li>Avoid people, pets, cars and swaying branches moving through the shot.</li>
        <li>
          Glass, mirrors, shiny floors, water and screens confuse matching. Expect holes there.
        </li>
      </ul>

      <h3>Photos or video?</h3>
      <ul>
        <li>
          Photos give the sharpest result per image and keep their lens data. 50–300 is typical for
          a house or a room.
        </li>
        <li>
          Video is easier to capture with full overlap. Film in 4K and move slowly. The app samples
          frames from it (see frames per second under Reconstruct); 1–2 fps is usually right, and
          more mostly adds processing time.
        </li>
        <li>You can mix both: a video for coverage plus photos of the details you care about.</li>
      </ul>

      <h3>360° cameras (Insta360 and similar)</h3>
      <ul>
        <li>
          Export from Insta360 Studio or the app as a 360° MP4 or JPG (equirectangular, no
          reframing). Raw .insv/.insp files aren't stitched yet, so they can't be used directly.
        </li>
        <li>
          Each 360° frame is split into four level views (front, right, back, left), so one frame
          counts as 4 images.
        </li>
        <li>
          Hold the camera on a stick above your head and walk slowly. The views stop 45° below the
          horizon, so you stay out of frame; anything below that, including the floor at your feet,
          is skipped.
        </li>
        <li>
          360° video while walking works far better than a few 360° photos. 3–5 spots per room
          gives only a rough shape. Photos every one or two steps work if you prefer stills.
        </li>
        <li>
          Each view has only about a quarter of the camera's resolution (about 1,900 px from 8K), so
          expect softer detail than from a normal camera.
        </li>
      </ul>
    </details>
  `,
  styles: `
    .guide {
      margin-bottom: 1rem;
    }
    summary {
      cursor: pointer;
      font-weight: 600;
    }
    h3 {
      font-size: 0.95rem;
      margin: 1rem 0 0.25rem;
    }
    p,
    ul {
      margin: 0.25rem 0;
    }
    li + li {
      margin-top: 0.2rem;
    }
  `,
})
export class CaptureGuide {
  readonly kind = input.required<ProjectKind>();
}
