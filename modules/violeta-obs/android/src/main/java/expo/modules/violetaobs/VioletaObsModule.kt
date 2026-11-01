package expo.modules.violetaobs

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Puente Expo entre JS y `VioletaCore` (T3).
 *
 * `Function` en Expo Modules es sincrónico: `mono()` y `append()` tienen que
 * devolver el valor en la misma llamada, y así el serializador de record.ts
 * puede construir la línea con la base de tiempo nativa (A3).
 *
 * El estado del arnés no vive acá sino en `VioletaCore`, porque la corrida se
 * liga en el arranque del proceso (MainActivity.onCreate), antes de que React
 * exista; este módulo es sólo la superficie que JS puede llamar.
 */
class VioletaObsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("VioletaObs")

    Function("mono") { VioletaCore.mono() }

    Function("append") { line: String -> VioletaCore.append(line).toDouble() }

    Function("setPhase") { phase: String -> VioletaCore.setPhase(phase) }

    Function("setVerdict") { outcome: String, dataJson: String ->
      VioletaCore.writeVerdict(outcome, dataJson)
    }

    Function("takePendingRequest") { VioletaCore.takePendingRequest() }

    Function("hardKill") { VioletaCore.hardKill() }
  }
}
