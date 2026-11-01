import { NativeModule, requireNativeModule } from 'expo';

declare class VioletaObsModule extends NativeModule<{}> {}

export default requireNativeModule<VioletaObsModule>('VioletaObs');
