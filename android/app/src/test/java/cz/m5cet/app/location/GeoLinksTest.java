package cz.m5cet.app.location;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 6.7: the links of a position (GeoLinks) — the same expected web URLs as
 * the web's test/geo-links.test.ts (one table, two platforms), the apps'
 * own links, the encoding of a label, and which lines a picker shows.
 */
public class GeoLinksTest {
    private static final double LAT = 50.0875, LON = 14.4213;
    private static final String LABEL = "Jana & Petr (doma)";

    @Test public void writesDegreesAndEncodesLikeTheWeb() {
        assertEquals("50.087500", GeoLinks.deg(50.0875));
        assertEquals("-33.856800", GeoLinks.deg(-33.8568));
        assertEquals("Jana%20%26%20Petr%20(doma)", GeoLinks.enc(LABEL));
        assertEquals("Ji%C5%99%C3%AD%20%C5%A0%C5%A5astn%C3%BD%2B1", GeoLinks.enc("Jiří Šťastný+1"));
        assertEquals("a!'()*~-_.b", GeoLinks.enc("a!'()*~-_.b"));
    }

    @Test public void theWebLinksAreTheWebs() {
        assertEquals("https://www.google.com/maps/dir/?api=1&destination=50.087500,14.421300", GeoLinks.web("google", LAT, LON, LABEL));
        assertEquals("https://waze.com/ul?ll=50.087500,14.421300&navigate=yes", GeoLinks.web("waze", LAT, LON, LABEL));
        // Mapy.com takes the longitude first.
        assertEquals("https://mapy.com/fnc/v1/route?end=14.421300,50.087500&routeType=car_fast&navigate=true", GeoLinks.web("mapy", LAT, LON, LABEL));
        assertEquals("https://www.openstreetmap.org/directions?to=50.087500,14.421300", GeoLinks.web("osm", LAT, LON, LABEL));
        assertEquals("https://m.uber.com/ul/?action=setPickup&pickup=my_location&dropoff[latitude]=50.087500&dropoff[longitude]=14.421300&dropoff[nickname]=Jana%20%26%20Petr%20(doma)",
            GeoLinks.web("uber", LAT, LON, LABEL));
        assertEquals("https://m.uber.com/ul/?action=setPickup&pickup=my_location&dropoff[latitude]=50.087500&dropoff[longitude]=14.421300", GeoLinks.web("uber", LAT, LON, ""));
        assertEquals("https://bolt.eu/", GeoLinks.web("bolt", LAT, LON, LABEL));
        assertEquals("https://www.liftago.cz/", GeoLinks.web("liftago", LAT, LON, LABEL));
        assertEquals("https://www.free-now.com/", GeoLinks.web("freenow", LAT, LON, LABEL));
        assertNull(GeoLinks.web("sygic", LAT, LON, LABEL));
    }

    @Test public void geoKeepsTheLabelInsideItsParentheses() {
        assertEquals("geo:50.087500,14.421300?q=50.087500,14.421300(Jana%20%26%20Petr%20%28doma%29)", GeoLinks.geoUri(LAT, LON, LABEL));
        assertEquals("geo:-33.856800,151.215300?q=-33.856800,151.215300", GeoLinks.geoUri(-33.8568, 151.2153, ""));
        assertEquals("50.087500, 14.421300", GeoLinks.destinationText(LAT, LON));
    }

    @Test public void theOrderIsTheWebsWithTheAndroidApps() {
        List<String> nav = new ArrayList<>(), ride = new ArrayList<>();
        for (GeoLinks.App a : GeoLinks.APPS) (GeoLinks.NAV.equals(a.kind) ? nav : ride).add(a.id);
        assertEquals(Arrays.asList("google", "waze", "mapy", "osmand", "sygic", "here", "osm"), nav);
        assertEquals(Arrays.asList("uber", "bolt", "liftago", "freenow"), ride);
        assertTrue(GeoLinks.packages().containsAll(Arrays.asList("com.google.android.apps.maps", "com.waze", "cz.seznam.mapy", "ee.mtakso.client", "taxi.android.client")));
    }

    private static List<String> ids(List<GeoLinks.Choice> cs) {
        List<String> out = new ArrayList<>();
        for (GeoLinks.Choice c : cs) out.add(c.id + (c.web ? "/web" : ""));
        return out;
    }

    private static GeoLinks.Choice byId(List<GeoLinks.Choice> cs, String id) {
        for (GeoLinks.Choice c : cs) if (c.id.equals(id)) return c;
        throw new AssertionError("no " + id + " in " + cs);
    }

    @Test public void navigationOffersTheInstalledAppsThenOtherGeoAppsThenTheWeb() {
        Set<String> installed = new HashSet<>(Arrays.asList("com.waze", "net.osmand", "com.sygic.aura"));
        Map<String, String> geo = new LinkedHashMap<>();
        geo.put("com.waze", "Waze");                 // a known app: listed once, with its own link
        geo.put("app.organicmaps", "Organic Maps");  // any other map app
        geo.put("com.generalmagic.magicearth", "Magic Earth");
        List<GeoLinks.Choice> cs = GeoLinks.choices(GeoLinks.NAV, LAT, LON, LABEL, installed, geo);
        assertEquals(Arrays.asList("waze", "osmand", "sygic", "geo:app.organicmaps", "geo:com.generalmagic.magicearth", "google/web", "mapy/web", "osm/web"), ids(cs));

        GeoLinks.Choice waze = byId(cs, "waze");
        assertEquals("com.waze", waze.pkg);
        assertEquals("waze://?ll=50.087500,14.421300&navigate=yes", waze.uri);
        assertEquals(GeoLinks.geoUri(LAT, LON, LABEL), waze.fallback);
        GeoLinks.Choice osmand = byId(cs, "osmand");
        assertEquals("net.osmand", osmand.pkg); // the free one when OsmAnd+ is not here
        assertEquals("osmand.api://navigate?dest_lat=50.087500&dest_lon=14.421300&dest_name=Jana%20%26%20Petr%20(doma)&profile=car&force=true", osmand.uri);
        assertEquals("com.sygic.aura://coordinate|14.421300|50.087500|drive", byId(cs, "sygic").uri);
        GeoLinks.Choice organic = byId(cs, "geo:app.organicmaps");
        assertEquals("Organic Maps", organic.name);
        assertEquals("app.organicmaps", organic.pkg);
        assertEquals(GeoLinks.geoUri(LAT, LON, LABEL), organic.uri);
        GeoLinks.Choice google = byId(cs, "google");
        assertTrue(google.web);
        assertNull(google.pkg);
        assertEquals("https://www.google.com/maps/dir/?api=1&destination=50.087500,14.421300", google.uri);
    }

    @Test public void theInstalledAppsGetTheirOwnLinks() {
        Set<String> installed = new HashSet<>(Arrays.asList("com.google.android.apps.maps", "cz.seznam.mapy", "com.here.app.maps", "net.osmand.plus", "net.osmand"));
        List<GeoLinks.Choice> cs = GeoLinks.choices(GeoLinks.NAV, LAT, LON, "", installed, Collections.emptyMap());
        assertEquals(Arrays.asList("google", "mapy", "osmand", "here", "waze/web", "osm/web"), ids(cs));
        assertEquals("google.navigation:q=50.087500,14.421300", byId(cs, "google").uri);
        assertEquals("https://mapy.com/fnc/v1/route?end=14.421300,50.087500&routeType=car_fast&navigate=true", byId(cs, "mapy").uri);
        assertEquals("net.osmand.plus", byId(cs, "osmand").pkg); // OsmAnd+ first
        assertEquals("osmand.api://navigate?dest_lat=50.087500&dest_lon=14.421300&profile=car&force=true", byId(cs, "osmand").uri);
        assertEquals("https://share.here.com/r/mylocation/50.087500,14.421300?m=d", byId(cs, "here").uri);
        assertEquals("https://share.here.com/r/mylocation/50.087500,14.421300,Jana?m=d",
            byId(GeoLinks.choices(GeoLinks.NAV, LAT, LON, "Jana", installed, null), "here").uri);
    }

    @Test public void ridesGiveUberTheDestinationAndOpenTheOthers() {
        Set<String> installed = new HashSet<>(Arrays.asList("com.ubercab", "ee.mtakso.client"));
        List<GeoLinks.Choice> cs = GeoLinks.choices(GeoLinks.RIDE, LAT, LON, "Jana", installed, null);
        assertEquals(Arrays.asList("uber", "bolt", "liftago/web", "freenow/web"), ids(cs));
        GeoLinks.Choice uber = cs.get(0);
        assertEquals("com.ubercab", uber.pkg);
        assertEquals("uber://?action=setPickup&pickup=my_location&dropoff[latitude]=50.087500&dropoff[longitude]=14.421300&dropoff[nickname]=Jana", uber.uri);
        assertTrue(uber.prefill);
        assertNull(uber.fallback);
        GeoLinks.Choice bolt = cs.get(1);
        assertEquals("ee.mtakso.client", bolt.pkg);
        assertNull(bolt.uri); // just open the app; the destination goes to the clipboard
        assertFalse(bolt.prefill);
        assertEquals("https://www.liftago.cz/", cs.get(2).uri);
        assertFalse(cs.get(2).prefill);
        // Nothing installed: the web for every one, Uber's with the destination.
        List<GeoLinks.Choice> none = GeoLinks.choices(GeoLinks.RIDE, LAT, LON, "", Collections.emptySet(), null);
        assertEquals(Arrays.asList("uber/web", "bolt/web", "liftago/web", "freenow/web"), ids(none));
        assertEquals("https://m.uber.com/ul/?action=setPickup&pickup=my_location&dropoff[latitude]=50.087500&dropoff[longitude]=14.421300", none.get(0).uri);
    }

    @Test public void aPlaceOutsideTheWorldHasNoChoices() {
        assertTrue(GeoLinks.choices(GeoLinks.NAV, 91, 0, "", Collections.emptySet(), null).isEmpty());
        assertTrue(GeoLinks.choices(GeoLinks.RIDE, Double.NaN, 0, "", Collections.emptySet(), null).isEmpty());
    }
}
